import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import type { FinalizeRunInput } from "./events.js";
import { finalizeRun } from "./events.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { asSystem, runAsSystem } from "./row-security.js";
import { runCodeKind, runCodeSpentKind, runLoginKind, runSecretKind } from "./run-secrets.js";

function finalizationFixture() {
  const tx = {
    $queryRaw: vi.fn(async () => []),
    run: {
      findUnique: vi.fn(async () => ({ status: "running", userId: "user-1" })),
      findUniqueOrThrow: vi.fn(async () => ({ sourceMessage: null })),
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async (_args: { data: { completedAt: Date } }) => ({ count: 1 })),
      update: vi.fn(async () => ({})),
    },
    attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
    task: { updateMany: vi.fn(async () => ({ count: 1 })) },
    thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
    event: {
      create: vi.fn(async () => ({ threadId: "thread-1", seq: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    secret: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
    },
    steeringMessage: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    message: { findFirst: vi.fn(async () => null) },
    bot: { update: vi.fn(async () => ({})) },
  };
  // Only the transaction client exposes writes, so an out-of-transaction update fails.
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
  } as unknown as PrismaClient;
  const input = {
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    leaseOwner: "worker-1",
    leaseFence: 1,
  };
  return { prisma, tx, input };
}

describe("finalizeRun turn-memory capture", () => {
  it("does not export a turn whose temporary credentials are about to be deleted", async () => {
    const { prisma, tx, input } = finalizationFixture();
    tx.secret.findFirst.mockResolvedValue({ id: "fixture-temporary-secret" });
    await finalizeRun(prisma, {
      ...input,
      outcome: "completed",
      blocks: [],
      memoryCapture: { sourceMemoryIds: [], scope: "isolated" },
    });
    expect(tx.run.update).not.toHaveBeenCalled();
    expect(tx.secret.deleteMany).toHaveBeenCalled();
  });
  it.each([
    { scope: "isolated", sourceMemoryIds: [] },
    { scope: "isolated", sourceMemoryIds: ["memory-a", "memory-b"] },
    { scope: "shared", sourceMemoryIds: [] },
    { scope: "shared", sourceMemoryIds: ["memory-a", "memory-b"] },
  ] as const)(
    "marks a completed run for $scope capture with recalled ids $sourceMemoryIds inside its transaction",
    async ({ scope, sourceMemoryIds }) => {
      const { prisma, tx, input } = finalizationFixture();

      await expect(
        finalizeRun(prisma, {
          ...input,
          outcome: "completed",
          blocks: [],
          memoryCapture: {
            sourceMemoryIds: [...sourceMemoryIds],
            scope,
            target: "synthetic-connection-target",
          },
        }),
      ).resolves.toEqual({ continuationRunId: null });

      const completedAt = tx.run.updateMany.mock.calls[0]![0].data.completedAt;
      expect(tx.run.update).toHaveBeenCalledExactlyOnceWith({
        where: { id: input.runId },
        data: {
          memoryCaptureDueAt: completedAt,
          memoryCapturedAt: null,
          memoryCaptureScope: scope,
          memoryCaptureTarget: "synthetic-connection-target",
          memoryRecallIds: sourceMemoryIds,
        },
      });
      expect(completedAt).toBeInstanceOf(Date);
    },
  );

  it("does not mark a failed run even when capture was requested", async () => {
    const { prisma, tx, input } = finalizationFixture();

    await finalizeRun(prisma, {
      ...input,
      outcome: "failed",
      error: "runtime failed",
      memoryCapture: { sourceMemoryIds: ["memory-a"], scope: "isolated" },
    });

    expect(tx.run.update).not.toHaveBeenCalled();
  });

  it.each([undefined, null])("keeps the legacy path when capture is %s", async (memoryCapture) => {
    const { prisma, tx, input } = finalizationFixture();

    await finalizeRun(prisma, {
      ...input,
      outcome: "completed",
      blocks: [],
      ...(memoryCapture === null ? { memoryCapture } : {}),
    });

    expect(tx.run.update).not.toHaveBeenCalled();
  });

  it("does not mark a run when the terminal lease check loses", async () => {
    const { prisma, tx, input } = finalizationFixture();
    tx.run.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      finalizeRun(prisma, {
        ...input,
        outcome: "completed",
        blocks: [],
        memoryCapture: { sourceMemoryIds: ["memory-a"], scope: "isolated" },
      }),
    ).resolves.toBe(false);

    expect(tx.run.update).not.toHaveBeenCalled();
  });

  it("propagates a failure after the capture write without publishing a completion", async () => {
    const { prisma, tx, input } = finalizationFixture();
    tx.attempt.updateMany.mockResolvedValue({ count: 0 });
    const publish = vi.fn(async () => undefined);

    await expect(
      finalizeRun(
        prisma,
        {
          ...input,
          outcome: "completed",
          blocks: [],
          memoryCapture: { sourceMemoryIds: ["memory-a"], scope: "shared" },
        },
        { publish } as never,
      ),
    ).rejects.toThrow("Active run attempt was not available to finalize");

    expect(tx.run.update).toHaveBeenCalledOnce();
    expect(tx.event.create).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

// The offline mocks above check transaction placement, not PostgreSQL rollback.
describePostgres("turn-memory capture commits and rollback (PostgreSQL)", () => {
  let system: PrismaClient;
  let close: () => Promise<void>;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string } | undefined;
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    system = asSystem(db.prisma);
    close = async () => {
      try {
        await db.prisma.$disconnect();
      } finally {
        await db.pool.end();
      }
    };
    identity = await runAsSystem("turn-memory test fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "sendblue", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
  });

  afterAll(async () => {
    try {
      if (identity) {
        await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
        await system.organization.deleteMany({ where: { id: identity.spaceId } });
        await system.user.deleteMany({ where: { id: identity.userId } });
      }
    } finally {
      await close?.();
    }
  });

  async function createRunningTurn() {
    const { userId, spaceId, botId, threadId } = identity!;
    const task = await system.task.create({
      data: { spaceId, botId, threadId, userId, prompt: "capture this turn", status: "running" },
    });
    const run = await system.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        userId,
        taskId: task.id,
        status: "running",
        trigger: "user",
        startedAt: new Date(),
        leaseOwner: "worker-1",
        leaseFence: 1,
      },
    });
    const attempt = await system.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    return {
      spaceId,
      botId,
      threadId,
      taskId: task.id,
      runId: run.id,
      attemptId: attempt.id,
      leaseOwner: "worker-1",
      leaseFence: 1,
    };
  }

  it.each(["login", "code", "spent", "waiting"] as const)(
    "completes and removes temporary %s credentials without scheduling external capture",
    async (kind) => {
      const input = await createRunningTurn();
      const owner = identity!;
      const secretKind =
        kind === "login"
          ? runLoginKind(input.runId, "example")
          : kind === "code"
            ? runCodeKind(input.runId)
            : kind === "spent"
              ? runCodeSpentKind(input.runId)
              : runSecretKind(input.runId);
      const secret = await system.secret.create({
        data: {
          userId: owner.userId,
          spaceId: owner.spaceId,
          kind: secretKind,
          ciphertext: "synthetic-sealed-secret",
        },
      });
      await finalizeRun(system, {
        ...input,
        outcome: "completed",
        blocks: [],
        memoryCapture: { sourceMemoryIds: [], scope: "isolated" },
      });
      const run = await system.run.findUniqueOrThrow({ where: { id: input.runId } });
      expect(run.status).toBe("completed");
      expect(run.memoryCaptureDueAt).toBeNull();
      expect(run.memoryCapturePayload).toBeNull();
      expect(await system.secret.findUnique({ where: { id: secret.id } })).toBeNull();
    },
  );

  it.each(["isolated", "shared", "failed", "legacy"] as const)(
    "commits the %s path",
    async (mode) => {
      const input = await createRunningTurn();
      const captures = mode === "isolated" || mode === "shared";
      const finish: FinalizeRunInput =
        mode === "failed"
          ? {
              ...input,
              outcome: "failed",
              error: "runtime failed",
              memoryCapture: { sourceMemoryIds: ["memory-a"], scope: "isolated" },
            }
          : {
              ...input,
              outcome: "completed",
              blocks: [],
              ...(captures
                ? {
                    memoryCapture: {
                      sourceMemoryIds: ["memory-a"],
                      scope: mode,
                      target: "fixture-target",
                    },
                  }
                : {}),
            };

      await expect(finalizeRun(system, finish)).resolves.toEqual({ continuationRunId: null });
      const run = await system.run.findUniqueOrThrow({ where: { id: input.runId } });

      expect(run.status).toBe(finish.outcome);
      expect(run.completedAt).toBeInstanceOf(Date);
      expect(run.memoryCaptureDueAt).toEqual(captures ? run.completedAt : null);
      expect(run.memoryCapturedAt).toBeNull();
      expect(run.memoryCaptureScope).toEqual(captures ? mode : null);
      expect(run.memoryCaptureTarget).toEqual(captures ? "fixture-target" : null);
      expect(run.memoryCapturePayload).toBeNull();
      expect(run.memoryRecallIds).toEqual(captures ? ["memory-a"] : null);
    },
  );

  it.each(["isolated", "shared"] as const)(
    "rolls back all %s capture columns when finalizing the attempt fails",
    async (scope) => {
      const input = await createRunningTurn();

      await expect(
        finalizeRun(system, {
          ...input,
          attemptId: "missing-attempt",
          outcome: "completed",
          blocks: [],
          memoryCapture: { sourceMemoryIds: ["memory-a"], scope },
        }),
      ).rejects.toThrow("Active run attempt was not available to finalize");

      const run = await system.run.findUniqueOrThrow({ where: { id: input.runId } });
      expect(run).toMatchObject({
        status: "running",
        completedAt: null,
        memoryCaptureDueAt: null,
        memoryCapturedAt: null,
        memoryCaptureScope: null,
        memoryCapturePayload: null,
        memoryRecallIds: null,
      });
      expect(await system.event.count({ where: { runId: input.runId } })).toBe(0);
    },
  );
});
