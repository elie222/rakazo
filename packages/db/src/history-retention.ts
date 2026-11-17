import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import { conversationRunsWhere } from "./cancel-runs.js";
import type { PrismaClient } from "./client.js";
import { parsePositiveInteger } from "./client.js";
import { runAsSystem } from "./row-security.js";
import { createRetentionPruner } from "./security-events.js";
import { THREAD_LOCK_TRANSACTION_OPTIONS, withTransactionRetry } from "./transaction-retry.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** About a century: far enough to mean never, and well inside the range of a date. */
const MAX_DAYS = 36_500;
const THREAD_PAGE_SIZE = 200;
/** Rows one transaction deletes, so a very old chat is cleared over several short ones. */
const CHUNK_SIZE = 500;

/**
 * Days to keep chat messages, or null to keep them forever (the default). A value that is set but
 * is not a whole number of days is an error, so a typo never leaves history kept while the
 * operator believes it is pruned.
 */
export function chatHistoryRetentionDays(source: NodeJS.ProcessEnv = process.env): number | null {
  const raw = source.CHAT_HISTORY_RETENTION_DAYS?.trim();
  if (!raw) return null;
  const days = /^\d+$/.test(raw) ? parsePositiveInteger(raw, 0) : 0;
  if (days === 0 || days > MAX_DAYS)
    throw new Error(
      `CHAT_HISTORY_RETENTION_DAYS must be a whole number of days, at most ${MAX_DAYS}`,
    );
  return days;
}

/**
 * Deletes one chunk of a chat's messages and events older than `cutoff`. Messages go as an
 * unbroken run from the oldest, so what stays is contiguous and history compaction (which
 * refuses a gap) keeps working. Returns how many rows went; 0 when nothing is due or the chat
 * must be left alone.
 */
async function pruneThreadChunk(
  prisma: Pick<PrismaClient, "$transaction">,
  threadId: string,
  cutoff: Date,
): Promise<number> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      // The lock every message writer takes: a send or a compaction save waits for this commit.
      const [thread] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM threads WHERE id = ${threadId} FOR NO KEY UPDATE`;
      if (!thread) return 0;
      // A waiting question or takeover is still answered from this chat, helpers' included.
      const active = await tx.run.findFirst({
        where: {
          AND: [conversationRunsWhere(threadId), { status: { in: [...ACTIVE_RUN_STATUSES] } }],
        },
        select: { id: true },
      });
      if (active) return 0;

      const firstKept = await tx.message.findFirst({
        where: { threadId, createdAt: { gte: cutoff } },
        orderBy: { seq: "asc" },
        select: { seq: true },
      });
      // A message queued behind a run that has not started is still owed a reply: keep it.
      const waiting = await tx.steeringMessage.findFirst({
        where: { claimedAt: null, message: { threadId } },
        orderBy: { message: { seq: "asc" } },
        select: { message: { select: { seq: true } } },
      });
      const stopAt = Math.min(
        firstKept?.seq ?? Number.POSITIVE_INFINITY,
        waiting?.message.seq ?? Number.POSITIVE_INFINITY,
      );
      const due = await tx.message.findMany({
        where: { threadId, ...(Number.isFinite(stopAt) ? { seq: { lt: stopAt } } : {}) },
        orderBy: { seq: "asc" },
        take: CHUNK_SIZE,
        select: { seq: true },
      });
      // Events repeat message content, so none that could belong to a message that stays goes:
      // only those older than the oldest message left after this chunk (and than the cutoff).
      const oldestKept = (
        await tx.message.aggregate({
          where: { threadId, seq: { gt: due.at(-1)?.seq ?? -1 } },
          _min: { createdAt: true },
        })
      )._min.createdAt;
      const eventsBefore = oldestKept && oldestKept < cutoff ? oldestKept : cutoff;
      const oldEvents = await tx.event.findMany({
        where: { threadId, createdAt: { lt: eventsBefore } },
        orderBy: { seq: "asc" },
        take: CHUNK_SIZE,
        select: { id: true },
      });

      const last = due.at(-1);
      if (last) {
        await tx.message.deleteMany({ where: { threadId, seq: { lte: last.seq } } });
        // As when a chat is cleared: the cursor sits on the last deleted message, so compaction
        // resumes at the first one left instead of stopping at a gap; the summary, which was
        // written from messages that are going, is dropped; and the generation moves, which
        // refuses a summary being saved from them and keeps a chat at generation 0 from being
        // read as one that predates generations. The messages left are sent as they are until
        // compaction summarizes them again.
        await tx.thread.update({
          where: { id: threadId },
          data: {
            historyCompactedUpToSeq: last.seq,
            historyCompactionSummary: null,
            historyCompactionGeneration: { increment: 1 },
          },
        });
      }
      if (oldEvents.length > 0)
        await tx.event.deleteMany({ where: { id: { in: oldEvents.map((event) => event.id) } } });
      return due.length + oldEvents.length;
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
}

/**
 * Deletes chat messages, and the events that carry their content, older than `retentionDays`
 * from chats with no run in progress. Returns the number of rows deleted. Runs, task prompts,
 * stored files and semantic memory are not touched.
 */
export async function pruneChatHistory(
  prisma: PrismaClient,
  retentionDays: number,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  let removed = 0;
  let after = "";
  for (;;) {
    // Only chats whose oldest message is past the window; one index probe per chat.
    const page = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT t.id FROM threads t
      WHERE t.id > ${after}
        AND (SELECT m."createdAt" FROM messages m WHERE m."threadId" = t.id
             ORDER BY m.seq ASC LIMIT 1) < ${cutoff}::timestamp(3)
      ORDER BY t.id LIMIT ${THREAD_PAGE_SIZE}`;
    for (const { id } of page) {
      for (;;) {
        // One chat that cannot be pruned (logged) must not stop the chats after it.
        const count = await bestEffort(
          `prune chat history of thread ${id}`,
          pruneThreadChunk(prisma, id, cutoff),
        );
        if (!count) break;
        removed += count;
      }
    }
    const lastId = page.at(-1)?.id;
    if (!lastId || page.length < THREAD_PAGE_SIZE) return removed;
    after = lastId;
  }
}

/** Prunes about once an hour from the reconciler's frequent tick. */
export function createChatHistoryPruner(
  prisma: PrismaClient,
  retentionDays: number,
  options: { intervalMs?: number; now?: () => Date } = {},
): () => Promise<void> {
  return createRetentionPruner(
    "chat.history",
    (at) => runAsSystem("prune chat history", () => pruneChatHistory(prisma, retentionDays, at)),
    options,
  );
}
