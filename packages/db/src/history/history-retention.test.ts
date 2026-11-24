import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../database/client.js";
import { chatHistoryRetentionDays, pruneChatHistory } from "./history-retention.js";

const NOW = new Date("2026-11-17T00:00:00.000Z");
const CUTOFF = new Date("2026-10-18T00:00:00.000Z");

type Fixture = {
  thread?: null;
  active?: boolean;
  firstKeptSeq?: number;
  waitingSeq?: number;
  messageSeqs?: number[];
  eventIds?: string[];
  oldestKeptAt?: Date;
  failChunk?: boolean;
  nonceSeqs?: number[];
};

function database(fixture: Fixture = {}) {
  const thread = fixture.thread === null ? null : { id: "thread-1" };
  // One chunk is due; the next look finds nothing left.
  let pending = { messageSeqs: fixture.messageSeqs ?? [], eventIds: fixture.eventIds ?? [] };
  const tx = {
    $queryRaw: vi.fn(async () => (thread ? [thread] : [])),
    run: { findFirst: vi.fn(async () => (fixture.active ? { id: "run" } : null)) },
    message: {
      findFirst: vi.fn(async () =>
        fixture.firstKeptSeq === undefined ? null : { seq: fixture.firstKeptSeq },
      ),
      findMany: vi.fn(async () =>
        pending.messageSeqs.map((seq) => ({
          id: `m${seq}`,
          seq,
          clientNonce: fixture.nonceSeqs?.includes(seq) ? `nonce-${seq}` : null,
        })),
      ),
      deleteMany: vi.fn(async () => ({ count: pending.messageSeqs.length })),
      aggregate: vi.fn(async () => ({ _min: { createdAt: fixture.oldestKeptAt ?? null } })),
    },
    steeringMessage: {
      findFirst: vi.fn(async () =>
        fixture.waitingSeq === undefined ? null : { message: { seq: fixture.waitingSeq } },
      ),
    },
    event: {
      findMany: vi.fn(async () => pending.eventIds.map((id) => ({ id }))),
      deleteMany: vi.fn(async () => {
        pending = { ...pending, eventIds: [] };
        return { count: 0 };
      }),
    },
    thread: { update: vi.fn(async () => ({})) },
    prunedMessageNonce: { createMany: vi.fn(async () => ({ count: 0 })) },
  };
  tx.message.deleteMany.mockImplementation(async () => {
    const count = pending.messageSeqs.length;
    pending = { ...pending, messageSeqs: [] };
    return { count };
  });
  const prisma = {
    $queryRaw: vi.fn(async () => [{ id: "thread-1" }]),
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<number>) => {
      if (fixture.failChunk) throw new Error("lock timeout");
      return run(tx);
    }),
  };
  return { prisma: prisma as unknown as PrismaClient, tx, raw: prisma.$queryRaw };
}

describe("chatHistoryRetentionDays", () => {
  it("keeps history forever when unset or empty", () => {
    expect(chatHistoryRetentionDays({})).toBeNull();
    expect(chatHistoryRetentionDays({ CHAT_HISTORY_RETENTION_DAYS: "" })).toBeNull();
    expect(chatHistoryRetentionDays({ CHAT_HISTORY_RETENTION_DAYS: "  " })).toBeNull();
  });

  it("reads a whole number of days", () => {
    expect(chatHistoryRetentionDays({ CHAT_HISTORY_RETENTION_DAYS: " 180 " })).toBe(180);
    expect(chatHistoryRetentionDays({ CHAT_HISTORY_RETENTION_DAYS: "36500" })).toBe(36_500);
  });

  it.each(["0", "-3", "soon", "1.5", "30d", "1e2", "0x10", "36501", "999999999"])(
    "refuses %j instead of keeping history",
    (value) => {
      expect(() => chatHistoryRetentionDays({ CHAT_HISTORY_RETENTION_DAYS: value })).toThrow(
        /CHAT_HISTORY_RETENTION_DAYS/,
      );
    },
  );
});

describe("pruneChatHistory", () => {
  it("deletes the oldest messages before the first kept one, and their events", async () => {
    const { prisma, tx } = database({
      firstKeptSeq: 3,
      messageSeqs: [0, 1, 2],
      eventIds: ["e1", "e2"],
    });
    const removed = await pruneChatHistory(prisma, 30, NOW);
    expect(removed).toBe(5);
    expect(tx.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { threadId: "thread-1", seq: { lt: 3 } } }),
    );
    expect(tx.message.deleteMany).toHaveBeenCalledWith({
      where: { threadId: "thread-1", seq: { lte: 2 } },
    });
    expect(tx.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { threadId: "thread-1", createdAt: { lt: CUTOFF } } }),
    );
    expect(tx.event.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["e1", "e2"] } } });
  });

  it("keeps the nonces of deleted messages so a replayed delivery is still recognized", async () => {
    const { prisma, tx } = database({ messageSeqs: [0, 1, 2], nonceSeqs: [0, 2] });
    await pruneChatHistory(prisma, 30, NOW);
    expect(tx.prunedMessageNonce.createMany).toHaveBeenCalledWith({
      data: [
        { threadId: "thread-1", clientNonce: "nonce-0", messageId: "m0", seq: 0 },
        { threadId: "thread-1", clientNonce: "nonce-2", messageId: "m2", seq: 2 },
      ],
      skipDuplicates: true,
    });
  });

  it("leaves a chat alone while a run or a helper's run is in progress", async () => {
    const { prisma, tx } = database({ active: true, messageSeqs: [0, 1], eventIds: ["e1"] });
    expect(await pruneChatHistory(prisma, 30, NOW)).toBe(0);
    expect(tx.message.deleteMany).not.toHaveBeenCalled();
    expect(tx.event.deleteMany).not.toHaveBeenCalled();
    expect(tx.thread.update).not.toHaveBeenCalled();
  });

  it("stops before a message still queued behind a run, and keeps the events that wait with it", async () => {
    const { prisma, tx } = database({
      firstKeptSeq: 9,
      waitingSeq: 4,
      messageSeqs: [0, 1, 2, 3],
      eventIds: ["e1"],
    });
    await pruneChatHistory(prisma, 30, NOW);
    expect(tx.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { threadId: "thread-1", seq: { lt: 4 } } }),
    );
  });

  it("deletes a chat whose every message is past the window", async () => {
    const { prisma, tx } = database({ messageSeqs: [0, 1] });
    await pruneChatHistory(prisma, 30, NOW);
    expect(tx.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { threadId: "thread-1" } }),
    );
  });

  it("moves the compaction cursor onto the last deleted message and drops the summary", async () => {
    const { prisma, tx } = database({ firstKeptSeq: 3, messageSeqs: [0, 1, 2] });
    await pruneChatHistory(prisma, 30, NOW);
    // Compaction resumes at seq 3 rather than failing on the gap, and a summary being saved from
    // the deleted messages is refused by the new generation.
    expect(tx.thread.update).toHaveBeenCalledWith({
      where: { id: "thread-1" },
      data: {
        historyCompactedUpToSeq: 2,
        historyCompactionSummary: null,
        historyCompactionGeneration: { increment: 1 },
      },
    });
  });

  it("does not touch the chat's compaction state when only events are old", async () => {
    const { prisma, tx } = database({ firstKeptSeq: 0, eventIds: ["e1"] });
    await pruneChatHistory(prisma, 30, NOW);
    expect(tx.message.deleteMany).not.toHaveBeenCalled();
    expect(tx.thread.update).not.toHaveBeenCalled();
    expect(tx.event.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["e1"] } } });
  });

  it("keeps the events of an old message that stays behind a newer one", async () => {
    const stays = new Date("2026-09-01T00:00:00.000Z");
    const { prisma, tx } = database({
      firstKeptSeq: 1,
      messageSeqs: [0],
      eventIds: ["e0"],
      oldestKeptAt: stays,
    });
    await pruneChatHistory(prisma, 30, NOW);
    // Measured after what this chunk deletes, so messages a later chunk takes are not counted
    // as kept, and ones that wait for it keep their events meanwhile.
    expect(tx.message.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { threadId: "thread-1", seq: { gt: 0 } } }),
    );
    expect(tx.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { threadId: "thread-1", createdAt: { lt: stays } } }),
    );
  });

  it("goes on to the next chat when one cannot be pruned", async () => {
    const { prisma, raw } = database({ failChunk: true });
    raw.mockResolvedValueOnce([{ id: "thread-1" }, { id: "thread-2" }]);
    await expect(pruneChatHistory(prisma, 30, NOW)).resolves.toBe(0);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("skips a chat deleted since it was listed", async () => {
    const { prisma, tx } = database({ thread: null, messageSeqs: [0] });
    expect(await pruneChatHistory(prisma, 30, NOW)).toBe(0);
    expect(tx.message.deleteMany).not.toHaveBeenCalled();
  });

  it("does not list chats again when the page is short", async () => {
    const { prisma, raw } = database({ firstKeptSeq: 1, messageSeqs: [0] });
    await pruneChatHistory(prisma, 30, NOW);
    expect(raw).toHaveBeenCalledTimes(1);
  });
});
