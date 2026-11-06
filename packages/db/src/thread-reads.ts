import type { Prisma, PrismaClient } from "./client.js";
import { runAsSystemInTransaction } from "./row-security.js";
import { THREAD_LOCK_TRANSACTION_OPTIONS, withTransactionRetry } from "./transaction-retry.js";

/**
 * Each member of a Space has their own read state for each chat there (`thread_reads`). A chat
 * with no row for someone reads as caught up for them.
 */

type Reader = { threadId: string; spaceId: string; userId: string };

/** Selects one person's read state on a thread, for `unreadFor`. */
export function readStateFor(userId: string) {
  return { where: { userId }, select: { unread: true } } as const;
}

export function unreadFor(thread: { reads: Array<{ unread: boolean }> }): boolean {
  return thread.reads[0]?.unread ?? false;
}

/**
 * Marks a chat unread for every member of its Space except whoever wrote the message at `seq`.
 * Someone with no read state yet had read everything before it.
 */
export async function markThreadUnreadForMembers(
  tx: Prisma.TransactionClient,
  input: { threadId: string; spaceId: string; seq: number; exceptUserId?: string },
): Promise<void> {
  await runAsSystemInTransaction(
    tx,
    "mark a chat unread for the members of its Space",
    () =>
      tx.$executeRaw`
      INSERT INTO thread_reads ("threadId", "userId", "spaceId", unread, "lastReadSeq")
      SELECT ${input.threadId}, m."userId", m."spaceId", true, ${input.seq - 1}::int
      FROM space_members m
      WHERE m."spaceId" = ${input.spaceId} AND m."userId" <> ${input.exceptUserId ?? ""}
      ON CONFLICT ("threadId", "userId") DO UPDATE SET unread = true`,
  );
}

/** A cleared chat has nothing left to read, for anyone. */
export async function clearThreadReads(tx: Prisma.TransactionClient, threadId: string) {
  await runAsSystemInTransaction(tx, "clear every member's read state for a cleared chat", () =>
    tx.threadRead.deleteMany({ where: { threadId } }),
  );
}

/**
 * Marks the chat read up to its latest message for one person. Returns the seq they had read up
 * to before, or null when the chat wasn't unread for them or nothing new arrived; the first
 * answer of a visit places the "New" divider. The thread row is held so a message cannot land
 * between reading the latest seq and writing it.
 */
export function markThreadReadFor(prisma: PrismaClient, reader: Reader): Promise<number | null> {
  const { threadId, spaceId, userId } = reader;
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const [thread] = await tx.$queryRaw<Array<{ nextMessageSeq: number }>>`
        SELECT "nextMessageSeq" FROM threads
        WHERE id = ${threadId} AND "spaceId" = ${spaceId}
        FOR SHARE`;
      if (!thread) return null;
      const latestSeq = thread.nextMessageSeq - 1;
      const read = await tx.threadRead.findUnique({
        where: { threadId_userId: { threadId, userId } },
        select: { unread: true, lastReadSeq: true },
      });
      if (!read || (!read.unread && read.lastReadSeq >= latestSeq)) return null;
      await tx.threadRead.update({
        where: { threadId_userId: { threadId, userId } },
        data: { unread: false, lastReadSeq: latestSeq },
      });
      // A chat only gets a divider when its unread dot was on, so replies seen live never do.
      return read.unread && read.lastReadSeq < latestSeq ? read.lastReadSeq : null;
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
}

/** Marks the chat unread for one person from the message at `seq`: the divider goes above it. */
export async function markThreadUnreadFromFor(
  prisma: Pick<PrismaClient, "threadRead">,
  reader: Reader,
  seq: number,
) {
  const state = { unread: true, lastReadSeq: seq - 1 };
  await prisma.threadRead.upsert({
    where: { threadId_userId: { threadId: reader.threadId, userId: reader.userId } },
    create: { ...reader, ...state },
    update: state,
  });
}

/** Mark as Read or Unread from the chat list, without moving where the divider goes. */
export async function setThreadUnreadFor(
  prisma: Pick<PrismaClient, "thread" | "threadRead">,
  reader: Reader,
  unread: boolean,
) {
  const where = { threadId_userId: { threadId: reader.threadId, userId: reader.userId } };
  if (!unread) {
    await prisma.threadRead.updateMany({
      where: { threadId: reader.threadId, userId: reader.userId, unread: true },
      data: { unread: false },
    });
    return;
  }
  const thread = await prisma.thread.findFirst({
    where: { id: reader.threadId, spaceId: reader.spaceId },
    select: { nextMessageSeq: true },
  });
  if (!thread) return;
  await prisma.threadRead.upsert({
    where,
    // Someone with no read state had read it all.
    create: { ...reader, unread: true, lastReadSeq: thread.nextMessageSeq - 1 },
    update: { unread: true },
  });
}
