import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  filterStrategicInitiativeTools,
  isStrategicInitiativeRun,
  reconcileStrategicInitiatives,
} from "./strategic-initiative.js";

function publisher() {
  const enqueue = vi.fn(async () => undefined);
  const jobs: JobPublisher = {
    enqueue,
    cancel: async () => undefined,
    close: async () => undefined,
  };
  return { jobs, enqueue };
}

function strategicPrisma(options: {
  bots: Array<{
    id: string;
    spaceId: string;
    userId: string;
    name: string;
    thread: { id: string } | null;
    scratchpadItems: Array<{ title: string; notes: string; updatedAt: Date }>;
  }>;
  existingNonce?: string;
  uniqueOnCreate?: boolean;
}) {
  const tasks: Array<{ prompt: string }> = [];
  const runs: Array<{ id: string; clientNonce: string; trigger: string }> = [];
  if (options.existingNonce) {
    runs.push({ id: "run-existing", clientNonce: options.existingNonce, trigger: "routine" });
  }
  const run = {
    findUnique: vi.fn(
      async ({ where }: { where: { spaceId_clientNonce: { clientNonce: string } } }) => {
        const nonce = where.spaceId_clientNonce.clientNonce;
        const found = runs.find((item) => item.clientNonce === nonce);
        return found ? { id: found.id } : null;
      },
    ),
    create: vi.fn(async ({ data }: { data: { clientNonce: string; trigger: string } }) => {
      if (options.uniqueOnCreate) throw { code: "P2002" };
      const id = `run-${runs.length + 1}`;
      runs.push({ id, clientNonce: data.clientNonce, trigger: data.trigger });
      return { id };
    }),
  };
  const task = {
    create: vi.fn(async ({ data }: { data: { prompt: string } }) => {
      tasks.push({ prompt: data.prompt });
      return { id: `task-${tasks.length}` };
    }),
  };
  const prisma = {
    bot: { findMany: vi.fn(async () => options.bots) },
    run,
    task,
    $transaction: vi.fn(
      async (fn: (tx: { run: typeof run; task: typeof task }) => Promise<unknown>) =>
        fn({ run, task }),
    ),
  } as unknown as PrismaClient;
  return { prisma, tasks, runs };
}

describe("reconcileStrategicInitiatives", () => {
  it("queues one routine-trigger run for stale scratchpad work", async () => {
    const now = new Date("2026-11-02T12:00:00.000Z");
    const stale = new Date("2026-11-01T00:00:00.000Z");
    const { prisma, tasks, runs } = strategicPrisma({
      bots: [
        {
          id: "bot-1",
          spaceId: "space-1",
          userId: "user-1",
          name: "Scout",
          thread: { id: "thread-1" },
          scratchpadItems: [
            {
              title: "Cerrar bug de login",
              notes: "falta validar refresh token",
              updatedAt: stale,
            },
          ],
        },
      ],
    });
    const { jobs, enqueue } = publisher();

    const queued = await reconcileStrategicInitiatives({ prisma, jobs, now, batchSize: 10 });

    expect(queued).toBe(1);
    expect(tasks[0]?.prompt).toContain("NO_RESPONSE");
    expect(runs[0]).toMatchObject({ trigger: "routine" });
    expect(runs[0]?.clientNonce).toContain("strategic-initiative:bot-1:");
    expect(enqueue).toHaveBeenCalledWith({
      name: "run.continue",
      payload: { runId: runs[0]?.id },
      replaceKey: `run:${runs[0]?.id}`,
    });
  });

  it("skips bots without a thread", async () => {
    const now = new Date("2026-11-02T12:00:00.000Z");
    const stale = new Date("2026-11-01T00:00:00.000Z");
    const { prisma } = strategicPrisma({
      bots: [
        {
          id: "bot-1",
          spaceId: "space-1",
          userId: "user-1",
          name: "Scout",
          thread: null,
          scratchpadItems: [{ title: "Tarea", notes: "", updatedAt: stale }],
        },
      ],
    });
    const { jobs, enqueue } = publisher();

    const queued = await reconcileStrategicInitiatives({ prisma, jobs, now, batchSize: 10 });

    expect(queued).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not duplicate work when the interval nonce already exists", async () => {
    const now = new Date("2026-11-02T12:00:00.000Z");
    const bucket = Math.floor(now.getTime() / (24 * 60 * 60 * 1000));
    const stale = new Date("2026-11-01T00:00:00.000Z");
    const { prisma } = strategicPrisma({
      existingNonce: `strategic-initiative:bot-1:${bucket}`,
      bots: [
        {
          id: "bot-1",
          spaceId: "space-1",
          userId: "user-1",
          name: "Scout",
          thread: { id: "thread-1" },
          scratchpadItems: [{ title: "Tarea", notes: "", updatedAt: stale }],
        },
      ],
    });
    const { jobs, enqueue } = publisher();

    const queued = await reconcileStrategicInitiatives({ prisma, jobs, now, batchSize: 10 });

    expect(queued).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("treats nonce races as already queued", async () => {
    const now = new Date("2026-11-02T12:00:00.000Z");
    const stale = new Date("2026-11-01T00:00:00.000Z");
    const { prisma } = strategicPrisma({
      uniqueOnCreate: true,
      bots: [
        {
          id: "bot-1",
          spaceId: "space-1",
          userId: "user-1",
          name: "Scout",
          thread: { id: "thread-1" },
          scratchpadItems: [{ title: "Tarea", notes: "", updatedAt: stale }],
        },
      ],
    });
    const { jobs, enqueue } = publisher();

    const queued = await reconcileStrategicInitiatives({ prisma, jobs, now, batchSize: 10 });

    expect(queued).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("strategic initiative tool guard", () => {
  it("recognizes strategic initiative runs by trigger and nonce prefix", () => {
    expect(
      isStrategicInitiativeRun({
        trigger: "routine",
        clientNonce: "strategic-initiative:bot-1:123",
      }),
    ).toBe(true);
    expect(isStrategicInitiativeRun({ trigger: "routine", clientNonce: "manual-run" })).toBe(false);
    expect(
      isStrategicInitiativeRun({
        trigger: "user",
        clientNonce: "strategic-initiative:bot-1:123",
      }),
    ).toBe(false);
  });

  it("keeps only safe user-facing tools for strategic initiative runs", () => {
    const tools = [
      { name: "ask_user" },
      { name: "message_user" },
      { name: "computer_shell" },
      { name: "gmail_send" },
    ];
    expect(
      filterStrategicInitiativeTools(tools, {
        trigger: "routine",
        clientNonce: "strategic-initiative:bot-1:123",
      }).map((tool) => tool.name),
    ).toEqual(["ask_user", "message_user"]);
  });

  it("does not filter regular runs", () => {
    const tools = [{ name: "ask_user" }, { name: "computer_shell" }];
    expect(
      filterStrategicInitiativeTools(tools, {
        trigger: "routine",
        clientNonce: "routine-test:manual",
      }).map((tool) => tool.name),
    ).toEqual(["ask_user", "computer_shell"]);
  });
});
