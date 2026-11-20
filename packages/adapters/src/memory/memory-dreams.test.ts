import type { JobPublisher } from "@rakazo/adapter-kit";
import { RetryJobLaterError } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  listMemoryDreams,
  pruneMemoryDreams,
  reconcileMemoryDreams,
  recordMemoryDream,
  settleMemoryDream,
} from "./memory-dreams.js";

const NOW = new Date("2026-02-02T23:30:00.000Z");

function jobPublisher() {
  return {
    enqueue: vi.fn(async () => undefined),
    enqueueIn: vi.fn(async () => undefined),
  } as unknown as JobPublisher & {
    enqueue: ReturnType<typeof vi.fn>;
    enqueueIn: ReturnType<typeof vi.fn>;
  };
}

function bot(overrides: Record<string, unknown> = {}) {
  return {
    id: "bot-1",
    spaceId: "space-1",
    userId: "user-1",
    name: "Scout",
    useOwnMemory: true,
    useSharedMemory: true,
    thread: { id: "thread-1" },
    ...overrides,
  };
}

function dreamPrisma(
  options: {
    bots?: ReturnType<typeof bot>[];
    messages?: Array<{ id: string; seq: number; blocks: unknown[] }>;
    lastDream?: { sourceSeq: number | null } | null;
    existingDream?: { id: string; status: string } | null;
    txError?: Error;
  } = {},
) {
  const tx = {
    $queryRaw: vi.fn(async () => []) as ReturnType<typeof vi.fn>,
    memoryDream: {
      findFirst: vi.fn(async () => options.existingDream ?? null),
      create: vi.fn(async () => ({ id: "dream-1" })),
    },
    thread: { create: vi.fn(async () => ({ id: "dream-thread" })) },
    task: { create: vi.fn(async () => ({ id: "dream-task" })) },
    run: { create: vi.fn(async () => ({ id: "dream-run" })) },
  };
  const prisma = {
    bot: { findMany: vi.fn(async () => options.bots ?? [bot()]) },
    user: { findMany: vi.fn(async () => [{ id: "user-1", timezone: "UTC" }]) },
    memoryDocument: { findMany: vi.fn(async () => []) },
    message: { findMany: vi.fn(async () => options.messages ?? []) },
    memoryDream: {
      findFirst: vi.fn(async () => options.lastDream ?? null),
      findUnique: vi.fn(async () => options.existingDream ?? null) as ReturnType<typeof vi.fn>,
      update: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []) as ReturnType<typeof vi.fn>,
    },
    memoryRevision: {
      findMany: vi.fn(async () => []) as ReturnType<typeof vi.fn>,
    },
    thread: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    run: { findUnique: vi.fn(async () => null) as ReturnType<typeof vi.fn> },
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => {
      if (options.txError) throw options.txError;
      return work(tx);
    }),
    $queryRaw: vi.fn(async () => []),
  };
  type Mock = ReturnType<typeof vi.fn>;
  type Raw = {
    bot: { findMany: Mock };
    user: { findMany: Mock };
    memoryDocument: { findMany: Mock };
    message: { findMany: Mock };
    memoryDream: {
      findFirst: Mock;
      findUnique: Mock;
      update: Mock;
      deleteMany: Mock;
      findMany: Mock;
    };
    memoryRevision: { findMany: Mock };
    thread: { deleteMany: Mock };
    run: { findUnique: Mock };
    $transaction: Mock;
    $queryRaw: Mock;
  };
  return { prisma: prisma as unknown as PrismaClient, tx, raw: prisma as unknown as Raw };
}

const userMessage = (seq: number, text: string) => ({
  id: `message-${seq}`,
  seq,
  blocks: [{ kind: "text", text }],
});

describe("reconcileMemoryDreams", () => {
  it("starts a dream at night with new user messages and backs it up", async () => {
    const jobs = jobPublisher();
    const { prisma, tx } = dreamPrisma({ messages: [userMessage(5, "I moved to Lisbon.")] });
    await reconcileMemoryDreams({ prisma, jobs, now: () => NOW });
    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          trigger: "memory_dream",
          status: "queued",
          threadId: "dream-thread",
        }),
      }),
    );
    expect(tx.memoryDream.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "queued", sourceSeq: 5 }),
      }),
    );
    expect(jobs.enqueueIn).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        name: "memory.dream",
        payload: { dreamId: "dream-1" },
        replaceKey: "memory-dream:dream-1",
      }),
    );
    // The run starts directly; the backup job remains until it finishes.
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "dream-run" } }),
    );
  });

  it("skips the daytime", async () => {
    const jobs = jobPublisher();
    const { prisma, tx } = dreamPrisma({ messages: [userMessage(5, "hello")] });
    await reconcileMemoryDreams({
      prisma,
      jobs,
      now: () => new Date("2026-02-02T12:00:00.000Z"),
    });
    expect(tx.run.create).not.toHaveBeenCalled();
  });

  it("skips a bot with no new user messages", async () => {
    const jobs = jobPublisher();
    const { prisma, tx } = dreamPrisma({ messages: [] });
    await reconcileMemoryDreams({ prisma, jobs, now: () => NOW });
    expect(tx.run.create).not.toHaveBeenCalled();
  });

  it("reads only messages after the last dream", async () => {
    const jobs = jobPublisher();
    const { prisma, raw } = dreamPrisma({
      messages: [userMessage(9, "new fact")],
      lastDream: { sourceSeq: 4 },
    });
    await reconcileMemoryDreams({ prisma, jobs, now: () => NOW });
    expect(raw.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ seq: { gt: 4 } }) }),
    );
  });

  it("stays quiet when another dream started inside the cooldown", async () => {
    const jobs = jobPublisher();
    const { prisma, tx } = dreamPrisma({
      messages: [userMessage(9, "new fact")],
      existingDream: { id: "earlier", status: "queued" },
    });
    await reconcileMemoryDreams({ prisma, jobs, now: () => NOW });
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});

describe("recordMemoryDream", () => {
  it("records the summary and the documents the run changed", async () => {
    const { prisma, raw } = dreamPrisma({ existingDream: { id: "dream-1", status: "queued" } });
    raw.memoryRevision.findMany.mockResolvedValueOnce([
      { document: { path: "MEMORY.md" } },
      { document: { path: "MEMORY.md" } },
      { document: { path: "team.md" } },
    ]);
    await recordMemoryDream(
      prisma,
      { id: "run-1", startedAt: new Date("2026-02-02T23:30:00.000Z") },
      { status: "completed", summary: "Moved to Lisbon." },
    );
    expect(raw.memoryDream.update).toHaveBeenCalledWith({
      where: { id: "dream-1" },
      data: expect.objectContaining({
        status: "completed",
        summary: "Moved to Lisbon.",
        changedPaths: ["MEMORY.md", "team.md"],
      }),
    });
  });

  it("does nothing once the dream is settled", async () => {
    const { prisma, raw } = dreamPrisma({ existingDream: { id: "dream-1", status: "completed" } });
    await recordMemoryDream(prisma, { id: "run-1" }, { status: "completed" });
    expect(raw.memoryDream.update).not.toHaveBeenCalled();
  });
});

describe("settleMemoryDream", () => {
  it("starts a run that never began", async () => {
    const jobs = jobPublisher();
    const { prisma, raw } = dreamPrisma({ existingDream: { id: "dream-1", status: "queued" } });
    raw.memoryDream.findUnique.mockResolvedValueOnce({
      id: "dream-1",
      runId: "run-1",
      status: "queued",
    });
    raw.run.findUnique.mockResolvedValueOnce({ id: "run-1", status: "queued", startedAt: null });
    await settleMemoryDream({ prisma, jobs }, "dream-1");
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-1" } }),
    );
  });

  it("settles from a run that already ended", async () => {
    const jobs = jobPublisher();
    const { prisma, raw } = dreamPrisma({ existingDream: { id: "dream-1", status: "queued" } });
    raw.memoryDream.findUnique.mockResolvedValueOnce({
      id: "dream-1",
      runId: "run-1",
      status: "queued",
    });
    raw.run.findUnique.mockResolvedValueOnce({ id: "run-1", status: "failed", startedAt: null });
    await settleMemoryDream({ prisma, jobs }, "dream-1");
    expect(raw.memoryDream.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed", errorKind: "interrupted" }),
      }),
    );
  });

  it("waits while the run is still working", async () => {
    const jobs = jobPublisher();
    const { prisma, raw } = dreamPrisma({ existingDream: { id: "dream-1", status: "queued" } });
    raw.memoryDream.findUnique.mockResolvedValueOnce({
      id: "dream-1",
      runId: "run-1",
      status: "queued",
    });
    raw.run.findUnique.mockResolvedValueOnce({ id: "run-1", status: "running", startedAt: null });
    await expect(settleMemoryDream({ prisma, jobs }, "dream-1")).rejects.toBeInstanceOf(
      RetryJobLaterError,
    );
  });
});

describe("pruneMemoryDreams", () => {
  it("deletes the records and hidden threads past the cap", async () => {
    const { prisma, raw } = dreamPrisma();
    raw.$queryRaw.mockResolvedValueOnce([{ id: "old-1", threadId: "thread-old-1" }]);
    await pruneMemoryDreams(prisma);
    expect(raw.memoryDream.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["old-1"] } } });
    expect(raw.thread.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["thread-old-1"] } },
    });
  });
});

describe("listMemoryDreams", () => {
  it("maps rows for the Memory page", async () => {
    const { prisma, raw } = dreamPrisma();
    raw.memoryDream.findMany.mockResolvedValueOnce([
      {
        id: "dream-1",
        status: "completed",
        summary: "Moved.",
        changedPaths: ["MEMORY.md"],
        errorKind: null,
        startedAt: new Date("2026-02-02T23:30:00.000Z"),
        finishedAt: new Date("2026-02-02T23:31:00.000Z"),
        createdAt: new Date("2026-02-02T23:30:00.000Z"),
      },
    ]);
    await expect(listMemoryDreams(prisma, { spaceId: "space-1", botId: "bot-1" })).resolves.toEqual(
      [
        {
          id: "dream-1",
          status: "completed",
          summary: "Moved.",
          changedPaths: ["MEMORY.md"],
          errorKind: null,
          startedAt: "2026-02-02T23:30:00.000Z",
          finishedAt: "2026-02-02T23:31:00.000Z",
          createdAt: "2026-02-02T23:30:00.000Z",
        },
      ],
    );
  });
});
