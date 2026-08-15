import type { WakeupDriver, WakeupJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";

type FakeRoutine = {
  id: string;
  botId: string;
  workspaceId: string;
  userId: string;
  prompt: string;
  cron: string;
  timezone: string;
  active: boolean;
};

const activeRoutine: FakeRoutine = {
  id: "routine-1",
  botId: "bot-1",
  workspaceId: "workspace-1",
  userId: "user-1",
  prompt: "Run the briefing",
  cron: "*/5 * * * *",
  timezone: "UTC",
  active: true,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("routine wakeups", () => {
  it("enqueues the next occurrence after the current run completes", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-15T12:34:30.000Z") });
    const { executor, jobs, persisted } = makeExecutor(activeRoutine, { id: "thread-1" });
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release: () => void = () => undefined;
    const currentRun = new Promise<void>((resolve) => {
      release = resolve;
    });
    executor.continueRun = async () => {
      markStarted();
      await currentRun;
    };

    const wake = executor.wakeRoutine(activeRoutine.id, "worker-1");
    await started;

    expect(jobs).toHaveLength(0);
    release();
    await wake;

    expect(persisted.lastRunAt).toEqual(new Date("2026-08-15T12:34:30.000Z"));
    expect(persisted.nextRunAt).toEqual(new Date("2026-08-15T12:35:00.000Z"));
    expect(jobs).toEqual([
      {
        name: "routine.wakeup",
        payload: { routineId: activeRoutine.id },
        runAt: persisted.nextRunAt,
        jobKey: `routine:${activeRoutine.id}`,
      },
    ]);
  });

  it.each([
    ["inactive", { ...activeRoutine, active: false }],
    ["missing", null],
  ])("does not schedule an %s routine", async (_label, routine) => {
    const { executor, jobs } = makeExecutor(routine, { id: "thread-1" });
    executor.continueRun = async () => undefined;

    await executor.wakeRoutine(activeRoutine.id, "worker-1");

    expect(jobs).toEqual([]);
  });

  it("does not schedule a routine without a thread", async () => {
    const { executor, jobs } = makeExecutor(activeRoutine, null);
    executor.continueRun = async () => undefined;

    await executor.wakeRoutine(activeRoutine.id, "worker-1");

    expect(jobs).toEqual([]);
  });

  it("does not require a wakeup driver", async () => {
    const { executor } = makeExecutor(activeRoutine, { id: "thread-1" }, false);
    executor.continueRun = async () => undefined;

    await expect(executor.wakeRoutine(activeRoutine.id, "worker-1")).resolves.toBeUndefined();
  });
});

function makeExecutor(
  routine: FakeRoutine | null,
  thread: { id: string } | null,
  includeWakeup = true,
) {
  const persisted: { lastRunAt?: Date; nextRunAt?: Date } = {};
  const jobs: WakeupJob[] = [];
  const prisma = {
    routine: {
      findUnique: async () => routine,
      update: async ({ data }: { data: { lastRunAt: Date; nextRunAt: Date } }) => {
        Object.assign(persisted, data);
        return routine ? { ...routine, ...data } : null;
      },
    },
    bot: {
      findUnique: async () => (routine ? { id: routine.botId, thread } : null),
    },
    task: {
      create: async () => ({ id: "task-1" }),
    },
    run: {
      create: async () => ({ id: "run-1" }),
    },
  } as unknown as PrismaClient;
  const wakeup = includeWakeup
    ? ({
        enqueue: async (job: WakeupJob) => {
          jobs.push(job);
        },
      } as unknown as WakeupDriver)
    : undefined;
  const executor = createRunExecutor({
    prisma,
    runtime: undefined as never,
    sandbox: undefined as never,
    memory: undefined as never,
    home: undefined as never,
    secrets: [],
    wakeup,
  });
  return { executor, jobs, persisted };
}
