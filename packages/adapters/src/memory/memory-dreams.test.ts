import { createHash } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { RetryJobLaterError } from "@rakazo/adapter-kit";
import type { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  listMemoryDreams,
  pruneMemoryDreams,
  reconcileMemoryDreams,
  recordMemoryDream,
  settleMemoryDream,
  startManualMemoryDream,
  undoMemoryDream,
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
    lastDream?: { sourceSeq: number | null; createdAt?: Date } | null;
    existingDream?: { id: string; status: string } | null;
    ownMemory?: string | null;
    sharedMemory?: string[];
    tidiedHash?: string | null;
    txError?: Error;
  } = {},
) {
  const ownDocument = options.ownMemory ? { content: options.ownMemory } : null;
  const existingDream = options.existingDream
    ? { botId: "bot-1", spaceId: "space-1", ...options.existingDream }
    : null;
  const tx = {
    $queryRaw: vi.fn(async () => []) as ReturnType<typeof vi.fn>,
    memoryDream: {
      findFirst: vi.fn(async () => options.existingDream ?? null),
      create: vi.fn(async () => ({ id: "dream-1" })),
      update: vi.fn(async () => ({})),
    },
    memoryDocument: {
      findFirst: vi.fn(async () => ownDocument),
      findUnique: vi.fn(async () => null) as ReturnType<typeof vi.fn>,
      update: vi.fn(async () => ({ revision: 1 })) as ReturnType<typeof vi.fn>,
      delete: vi.fn(async () => ({})),
    },
    memoryRevision: {
      findFirst: vi.fn(async () => null) as ReturnType<typeof vi.fn>,
      create: vi.fn(async () => ({})),
    },
    bot: { update: vi.fn(async () => ({})) },
    thread: { create: vi.fn(async () => ({ id: "dream-thread" })) },
    task: { create: vi.fn(async () => ({ id: "dream-task" })) },
    run: {
      create: vi.fn(async () => ({ id: "dream-run" })),
      findFirst: vi.fn(async () => null) as ReturnType<typeof vi.fn>,
    },
  };
  const prisma = {
    bot: {
      findMany: vi.fn(async (args?: { where?: { id?: { gt?: string } }; take?: number }) => {
        const all = options.bots ?? [bot()];
        const after = args?.where?.id?.gt;
        const page = after ? all.filter((candidate) => candidate.id > after) : all;
        return page.slice(0, args?.take ?? page.length);
      }),
      findFirst: vi.fn(async () => options.bots?.[0] ?? bot()),
    },
    run: {
      findUnique: vi.fn(async () => null) as ReturnType<typeof vi.fn>,
      findFirst: vi.fn(async () => null) as ReturnType<typeof vi.fn>,
    },
    user: {
      findMany: vi.fn(async () => [{ id: "user-1", timezone: "UTC" }]),
      findUnique: vi.fn(async () => ({ timezone: "UTC" })),
    },
    memoryDocument: {
      findFirst: vi.fn(async () => ownDocument),
      findMany: vi.fn(async () => (options.sharedMemory ?? []).map((content) => ({ content }))),
    },
    message: { findMany: vi.fn(async () => options.messages ?? []) },
    memoryDream: {
      findFirst: vi.fn(async () => options.lastDream ?? null),
      findUnique: vi.fn(async () => existingDream) as ReturnType<typeof vi.fn>,
      update: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []) as ReturnType<typeof vi.fn>,
      findUniqueOrThrow: vi.fn(async () => ({
        id: "dream-1",
        status: "queued",
        reason: "idle",
        summary: null,
        changedPaths: [],
        added: [],
        archived: [],
        errorKind: null,
        startedAt: null,
        finishedAt: null,
        createdAt: new Date("2026-02-02T23:30:00.000Z"),
      })) as ReturnType<typeof vi.fn>,
    },
    memoryRevision: {
      findMany: vi.fn(async () => []) as ReturnType<typeof vi.fn>,
      findFirst: vi.fn(async () => null) as ReturnType<typeof vi.fn>,
    },
    thread: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => {
      if (options.txError) throw options.txError;
      return work(tx);
    }),
    $queryRaw: vi.fn(async () => []),
  };
  type Mock = ReturnType<typeof vi.fn>;
  type Raw = {
    bot: { findMany: Mock; findFirst: Mock };
    user: { findMany: Mock; findUnique: Mock };
    memoryDocument: { findFirst: Mock; findMany: Mock };
    message: { findMany: Mock };
    memoryDream: {
      findFirst: Mock;
      findUnique: Mock;
      update: Mock;
      deleteMany: Mock;
      findMany: Mock;
      findUniqueOrThrow: Mock;
    };
    memoryRevision: { findMany: Mock; findFirst: Mock };
    thread: { deleteMany: Mock };
    run: { findUnique: Mock; findFirst: Mock };
    $transaction: Mock;
    $queryRaw: Mock;
  };
  return { prisma: prisma as unknown as PrismaClient, tx, raw: prisma as unknown as Raw };
}

const userMessage = (seq: number, text: string, agoMs = 6 * 60_000) => ({
  id: `message-${seq}`,
  seq,
  createdAt: new Date(NOW.getTime() - agoMs),
  blocks: [{ kind: "text", text }],
});

describe("reconcileMemoryDreams", () => {
  it("starts a dream once the user has been quiet and backs it up", async () => {
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

  it("waits while the conversation is still active", async () => {
    const jobs = jobPublisher();
    const { prisma, tx } = dreamPrisma({
      messages: [userMessage(5, "hello", 60_000)],
    });
    await reconcileMemoryDreams({ prisma, jobs, now: () => NOW });
    expect(tx.run.create).not.toHaveBeenCalled();
  });

  it("does not start while a run began after the sweep checked", async () => {
    const jobs = jobPublisher();
    const { prisma, tx } = dreamPrisma({
      messages: [userMessage(5, "I moved to Lisbon.")],
    });
    tx.run.findFirst.mockResolvedValueOnce({ id: "active-run" });
    await reconcileMemoryDreams({ prisma, jobs, now: () => NOW });
    expect(tx.memoryDream.create).not.toHaveBeenCalled();
    expect(jobs.enqueueIn).not.toHaveBeenCalled();
  });

  it("runs at once when eight user messages are waiting", async () => {
    const jobs = jobPublisher();
    const { prisma, tx } = dreamPrisma({
      messages: Array.from({ length: 8 }, (_, index) => userMessage(index + 1, `fact ${index}`)),
    });
    await reconcileMemoryDreams({ prisma, jobs, now: () => NOW });
    expect(tx.run.create).toHaveBeenCalledOnce();
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

  it("advances past an oversized message instead of dropping it", async () => {
    const jobs = jobPublisher();
    const { prisma, tx } = dreamPrisma({
      messages: [userMessage(5, "x".repeat(40_000)), userMessage(6, "new fact")],
    });
    await reconcileMemoryDreams({ prisma, jobs, now: () => NOW });
    // The cursor is the message the dream actually read; trimming here would strand it forever.
    expect(tx.memoryDream.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sourceSeq: 5 }) }),
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

  // Eight hundred five-character lines: the bot's own notes exactly at their 1,200-token cap.
  const fullMemory = "xxxxx\n".repeat(800);

  it("tidies a nearly full memory whose notes changed", async () => {
    const jobs = jobPublisher();
    const { prisma, tx } = dreamPrisma({
      bots: [bot({ memoryTidiedHash: "an older hash" })],
      ownMemory: fullMemory,
    });
    await reconcileMemoryDreams({ prisma, jobs, now: () => NOW });
    expect(tx.memoryDream.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reason: "tidy" }) }),
    );
  });

  it("skips the tidy while the notes are unchanged", async () => {
    const jobs = jobPublisher();
    const { prisma, tx } = dreamPrisma({
      bots: [bot({ memoryTidiedHash: createHash("sha256").update(fullMemory).digest("hex") })],
      ownMemory: fullMemory,
      lastDream: { sourceSeq: 5, createdAt: new Date(NOW.getTime() - 60 * 60_000) },
    });
    await reconcileMemoryDreams({ prisma, jobs, now: () => NOW });
    expect(tx.memoryDream.create).not.toHaveBeenCalled();
  });

  it("waits six hours between tidies", async () => {
    const jobs = jobPublisher();
    const { prisma, tx } = dreamPrisma({
      bots: [bot({ memoryTidiedHash: "an older hash" })],
      ownMemory: fullMemory,
      existingDream: { id: "earlier", status: "completed" },
    });
    await reconcileMemoryDreams({ prisma, jobs, now: () => NOW });
    expect(tx.memoryDream.create).not.toHaveBeenCalled();
  });

  it("reviews the notes once a day", async () => {
    const jobs = jobPublisher();
    const { prisma, tx } = dreamPrisma({ sharedMemory: ["Likes tea."] });
    await reconcileMemoryDreams({ prisma, jobs, now: () => NOW });
    expect(tx.memoryDream.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reason: "review" }) }),
    );
  });

  it("skips the review when a dream already ran today", async () => {
    const jobs = jobPublisher();
    const { prisma, tx } = dreamPrisma({
      lastDream: { sourceSeq: 5, createdAt: new Date(NOW.getTime() - 60 * 60_000) },
      sharedMemory: ["Likes tea."],
    });
    await reconcileMemoryDreams({ prisma, jobs, now: () => NOW });
    expect(tx.memoryDream.create).not.toHaveBeenCalled();
  });

  it("skips the review while the notes are empty", async () => {
    const jobs = jobPublisher();
    const { prisma, tx } = dreamPrisma();
    await reconcileMemoryDreams({ prisma, jobs, now: () => NOW });
    expect(tx.memoryDream.create).not.toHaveBeenCalled();
  });

  it("scans past the first page of bots", async () => {
    const jobs = jobPublisher();
    const bots = Array.from({ length: 21 }, (_, index) =>
      bot({
        id: `bot-${String(index + 1).padStart(2, "0")}`,
        thread: { id: `thread-${index + 1}` },
      }),
    );
    const { prisma, raw } = dreamPrisma({ bots });
    await reconcileMemoryDreams({ prisma, jobs, now: () => NOW });
    // Bots with nothing new stay eligible, so the pass pages on rather than stopping at the first
    // batch and never reaching later bots.
    expect(raw.bot.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: expect.objectContaining({ id: { gt: "bot-20" } }) }),
    );
  });
});

describe("recordMemoryDream", () => {
  it("records the summary and the documents the run changed", async () => {
    const { prisma, raw, tx } = dreamPrisma({
      existingDream: { id: "dream-1", status: "queued" },
    });
    raw.memoryRevision.findMany.mockResolvedValueOnce([
      {
        documentId: "doc-1",
        revision: 2,
        content: "Moved to Lisbon.\nLikes tea.",
        document: { path: "MEMORY.md" },
      },
      {
        documentId: "doc-2",
        revision: 1,
        content: "Standup at nine.",
        document: { path: "team.md" },
      },
    ]);
    raw.memoryRevision.findFirst
      .mockResolvedValueOnce({ content: "Moved to Lisbon.\nOld note." })
      .mockResolvedValueOnce(null);
    await recordMemoryDream(
      prisma,
      { id: "run-1", startedAt: new Date("2026-02-02T23:30:00.000Z") },
      { status: "completed", summary: "Moved to Lisbon." },
    );
    expect(tx.memoryDream.update).toHaveBeenCalledWith({
      where: { id: "dream-1" },
      data: expect.objectContaining({
        status: "completed",
        summary: "Moved to Lisbon.",
        changedPaths: ["MEMORY.md", "team.md"],
        added: ["Likes tea.", "Standup at nine."],
        archived: ["Old note."],
      }),
    });
  });

  it("fingerprints the notes the dream left behind", async () => {
    const { prisma, tx } = dreamPrisma({
      existingDream: { id: "dream-1", status: "queued" },
      ownMemory: "Moved to Lisbon.\n",
    });
    await recordMemoryDream(prisma, { id: "run-1" }, { status: "completed" });
    expect(tx.bot.update).toHaveBeenCalledWith({
      where: { id: "bot-1" },
      data: {
        memoryTidiedHash: createHash("sha256").update("Moved to Lisbon.\n").digest("hex"),
      },
    });
  });

  it("does nothing once the dream is settled", async () => {
    const { prisma, tx } = dreamPrisma({
      existingDream: { id: "dream-1", status: "completed" },
    });
    await recordMemoryDream(prisma, { id: "run-1" }, { status: "completed" });
    expect(tx.memoryDream.update).not.toHaveBeenCalled();
    expect(tx.bot.update).not.toHaveBeenCalled();
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
    const { prisma, raw, tx } = dreamPrisma({
      existingDream: { id: "dream-1", status: "queued" },
    });
    raw.memoryDream.findUnique.mockResolvedValueOnce({
      id: "dream-1",
      runId: "run-1",
      status: "queued",
    });
    raw.run.findUnique.mockResolvedValueOnce({ id: "run-1", status: "failed", startedAt: null });
    await settleMemoryDream({ prisma, jobs }, "dream-1");
    expect(tx.memoryDream.update).toHaveBeenCalledWith(
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
        reason: "tidy",
        summary: "Moved.",
        changedPaths: ["MEMORY.md"],
        errorKind: null,
        undoneAt: null,
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
          reason: "tidy",
          summary: "Moved.",
          changedPaths: ["MEMORY.md"],
          errorKind: null,
          undoneAt: null,
          startedAt: "2026-02-02T23:30:00.000Z",
          finishedAt: "2026-02-02T23:31:00.000Z",
          createdAt: "2026-02-02T23:30:00.000Z",
        },
      ],
    );
  });
});

describe("startManualMemoryDream", () => {
  it("refuses while both memory banks are off", async () => {
    const { prisma } = dreamPrisma({
      bots: [bot({ useOwnMemory: false, useSharedMemory: false })],
    });
    await expect(
      startManualMemoryDream(
        { prisma, jobs: jobPublisher() },
        {
          spaceId: "space-1",
          botId: "bot-1",
        },
      ),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" } satisfies Partial<ClientError>);
  });

  it("refuses while the bot is working", async () => {
    const { prisma, raw } = dreamPrisma();
    raw.run.findFirst.mockResolvedValueOnce({ id: "run-busy" });
    await expect(
      startManualMemoryDream(
        { prisma, jobs: jobPublisher() },
        {
          spaceId: "space-1",
          botId: "bot-1",
        },
      ),
    ).rejects.toMatchObject({ kind: "CONFLICT" } satisfies Partial<ClientError>);
  });

  it("refuses a second dream inside the manual cooldown", async () => {
    const { prisma, tx } = dreamPrisma({
      messages: [userMessage(5, "hello")],
      existingDream: { id: "earlier", status: "completed" },
    });
    await expect(
      startManualMemoryDream(
        { prisma, jobs: jobPublisher() },
        {
          spaceId: "space-1",
          botId: "bot-1",
        },
      ),
    ).rejects.toMatchObject({ kind: "CONFLICT" } satisfies Partial<ClientError>);
    expect(tx.run.create).not.toHaveBeenCalled();
  });

  it("starts a dream and returns its record", async () => {
    const jobs = jobPublisher();
    const { prisma, tx } = dreamPrisma({ messages: [userMessage(7, "New fact.")] });
    await expect(
      startManualMemoryDream({ prisma, jobs }, { spaceId: "space-1", botId: "bot-1" }),
    ).resolves.toMatchObject({ id: "dream-1", status: "queued" });
    expect(tx.run.create).toHaveBeenCalledOnce();
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { runId: "dream-run" } }),
    );
  });
});

describe("undoMemoryDream", () => {
  const dreamRow = {
    id: "dream-1",
    status: "completed",
    reason: "idle",
    summary: null,
    changedPaths: ["MEMORY.md"],
    added: [],
    archived: [],
    errorKind: null,
    createdAt: NOW,
    botId: "bot-1",
    runId: "run-1",
    undoneAt: null,
    startedAt: null,
    finishedAt: null,
  };

  function undoDream() {
    const fixture = dreamPrisma();
    fixture.raw.memoryDream.findFirst
      .mockResolvedValueOnce(dreamRow)
      .mockResolvedValueOnce({ id: "dream-1" });
    fixture.raw.memoryRevision.findMany.mockResolvedValueOnce([
      { documentId: "doc-1", revision: 2 },
    ]);
    return fixture;
  }

  it("restores the content the dream replaced", async () => {
    const { prisma, tx } = undoDream();
    tx.memoryDocument.findUnique.mockResolvedValueOnce({
      id: "doc-1",
      revision: 2,
      spaceId: "space-1",
    });
    tx.memoryRevision.findFirst.mockResolvedValueOnce({ content: "before" });
    tx.memoryDocument.update.mockResolvedValueOnce({ revision: 3 });
    tx.memoryDream.update.mockResolvedValueOnce({ ...dreamRow, undoneAt: NOW });

    await expect(
      undoMemoryDream(prisma, { spaceId: "space-1", dreamId: "dream-1" }),
    ).resolves.toMatchObject({ id: "dream-1", undoneAt: NOW.toISOString() });
    expect(tx.memoryDocument.update).toHaveBeenCalledWith({
      where: { id: "doc-1" },
      data: { content: "before", revision: 3 },
    });
    expect(tx.memoryRevision.create).toHaveBeenCalledWith({
      data: { documentId: "doc-1", revision: 3, content: "before", sourceKind: "undo" },
    });
  });

  it("removes a document the dream created", async () => {
    const { prisma, tx } = undoDream();
    tx.memoryDocument.findUnique.mockResolvedValueOnce({
      id: "doc-1",
      revision: 2,
      spaceId: "space-1",
    });
    tx.memoryRevision.findFirst.mockResolvedValueOnce(null);
    tx.memoryDream.update.mockResolvedValueOnce({ ...dreamRow, undoneAt: NOW });

    await undoMemoryDream(prisma, { spaceId: "space-1", dreamId: "dream-1" });
    expect(tx.memoryDocument.delete).toHaveBeenCalledWith({ where: { id: "doc-1" } });
    expect(tx.memoryRevision.create).not.toHaveBeenCalled();
  });

  it("undoes a document the dream wrote more than once", async () => {
    const fixture = dreamPrisma();
    fixture.raw.memoryDream.findFirst
      .mockResolvedValueOnce(dreamRow)
      .mockResolvedValueOnce({ id: "dream-1" });
    fixture.raw.memoryRevision.findMany.mockResolvedValueOnce([
      { documentId: "doc-1", revision: 2 },
      { documentId: "doc-1", revision: 3 },
    ]);
    const { prisma, tx } = fixture;
    tx.memoryDocument.findUnique.mockResolvedValueOnce({
      id: "doc-1",
      revision: 3,
      spaceId: "space-1",
    });
    tx.memoryRevision.findFirst.mockResolvedValueOnce({ content: "before" });
    tx.memoryDocument.update.mockResolvedValueOnce({ revision: 4 });
    tx.memoryDream.update.mockResolvedValueOnce({ ...dreamRow, undoneAt: NOW });

    await undoMemoryDream(prisma, { spaceId: "space-1", dreamId: "dream-1" });
    // The live revision is the dream's last write; the content comes from before its first.
    expect(tx.memoryRevision.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { documentId: "doc-1", revision: { lt: 2 } } }),
    );
    expect(tx.memoryDocument.update).toHaveBeenCalledWith({
      where: { id: "doc-1" },
      data: { content: "before", revision: 4 },
    });
  });

  it("refuses once the memory changed since the dream", async () => {
    const { prisma, tx } = undoDream();
    tx.memoryDocument.findUnique.mockResolvedValueOnce({
      id: "doc-1",
      revision: 3,
      spaceId: "space-1",
    });

    await expect(
      undoMemoryDream(prisma, { spaceId: "space-1", dreamId: "dream-1" }),
    ).rejects.toMatchObject({ kind: "CONFLICT" } satisfies Partial<ClientError>);
    expect(tx.memoryDream.update).not.toHaveBeenCalled();
  });

  it("refuses a dream that is not the latest one", async () => {
    const { prisma, raw } = undoDream();
    raw.memoryDream.findFirst
      .mockReset()
      .mockResolvedValueOnce(dreamRow)
      .mockResolvedValueOnce({ id: "newer-dream" });

    await expect(
      undoMemoryDream(prisma, { spaceId: "space-1", dreamId: "dream-1" }),
    ).rejects.toMatchObject({ kind: "CONFLICT" } satisfies Partial<ClientError>);
  });
});
