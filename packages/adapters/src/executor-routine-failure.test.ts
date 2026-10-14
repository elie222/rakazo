import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

const NOW = new Date("2026-03-02T09:00:00.000Z");
const MINUTE = 60_000;

interface Scenario {
  error: Error;
  trigger?: string;
  routineNotify?: boolean;
  notifyOnFinish?: boolean;
  nextRunAt?: Date | null;
  toolCalls?: number;
  botMessages?: number;
}

async function failRun(scenario: Scenario) {
  const trigger = scenario.trigger ?? "routine";
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger,
    routineId: trigger === "routine" ? "routine-1" : null,
    leaseFence: 0,
  };
  const runtimeRun = vi.fn(async function* () {
    yield* [];
    throw scenario.error;
  });
  const prisma = {
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      findFirst: vi.fn(async () => ({
        bot: { notifyOnFinish: scenario.notifyOnFinish ?? true },
        thread: { groupId: null },
      })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    routine: {
      findUnique: vi.fn(async () => ({
        notify: scenario.routineNotify ?? true,
        nextRunAt:
          scenario.nextRunAt === undefined
            ? new Date(NOW.getTime() + 24 * 60 * MINUTE)
            : scenario.nextRunAt,
      })),
    },
    event: { count: vi.fn(async () => scenario.toolCalls ?? 0) },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        computerId: "computer-1",
        computerSwitching: false,
        memoryScope: null,
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 1,
      })),
    },
    message: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => scenario.botMessages ?? 0),
    },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Sweep the inbox" })) },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    secret: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    spaceBackupModel: { findMany: vi.fn(async () => []) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: "deepseek/deepseek-v4-flash-0731",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    externalEffect: { findMany: vi.fn(async () => []) },
    artifact: { findMany: vi.fn(async () => []) },
  };
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const enqueue = vi.fn(async () => undefined);
  const send = vi.fn(async () => undefined);
  const executor = createRunExecutor({
    prisma,
    deploymentModelKey: "fake-deployment-key",
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      writeFile: vi.fn(async () => undefined),
      async *exportWorkspace() {
        yield* [];
      },
    },
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    artifacts: { get: vi.fn() },
    events: { append: vi.fn(async () => undefined), finalizeRun },
    jobs: { enqueue },
    notifications: { send },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  expect(finalizeRun).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: "failed", error: scenario.error.message }),
  );
  return { send };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("routine failure notifications", () => {
  it("tells the owner about a failed routine when the routine asks to notify", async () => {
    const { send } = await failRun({
      error: new Error("Invalid API key"),
      routineNotify: true,
      notifyOnFinish: false,
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "failure", title: "Assistant failed" }),
      expect.anything(),
    );
  });

  it("stays quiet about a failed routine that turned notifications off", async () => {
    const { send } = await failRun({
      error: new Error("Invalid API key"),
      routineNotify: false,
      notifyOnFinish: true,
    });

    expect(send).not.toHaveBeenCalled();
  });
});
