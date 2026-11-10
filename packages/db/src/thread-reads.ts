import type { Prisma, PrismaClient } from "./client.js";
import { runAsSystem, runAsSystemInTransaction } from "./row-security.js";
import { THREAD_LOCK_TRANSACTION_OPTIONS, withTransactionRetry } from "./transaction-retry.js";

/**
 * Each member of a Space has their own state for each chat there (`thread_reads`): how far they
 * have read, and any snooze, mute or hide. A chat with no row for someone is caught up, not
 * snoozed or hidden, and muted only when it is a bot's chat with its notifications off.
 */

type Reader = { threadId: string; spaceId: string; userId: string };

/** One person's own state on a thread, as `readStateFor` selects it. */
export type ThreadReadState = {
  unread: boolean;
  snoozedUntil: Date | null;
  muted: boolean | null;
  hidden: boolean;
};

/** Selects one person's own state on a thread, for `unreadFor`, `snoozedUntilFor` and `mutedFor`. */
export function readStateFor(userId: string) {
  return {
    where: { userId },
    select: { unread: true, snoozedUntil: true, muted: true, hidden: true },
  } as const;
}

export function unreadFor(thread: { reads: Array<{ unread: boolean }> }): boolean {
  return thread.reads[0]?.unread ?? false;
}

export function snoozedUntilFor(thread: {
  reads: Array<{ snoozedUntil: Date | null }>;
}): string | null {
  return thread.reads[0]?.snoozedUntil?.toISOString() ?? null;
}

/**
 * Whether this person muted the chat. Until they choose, a bot's chat follows the bot's own
 * notification setting, so a chat that was silent stays silent; a group is not muted.
 */
export function mutedFor(
  thread: { reads: Array<{ muted: boolean | null }> },
  bot?: { notifyOnFinish: boolean } | null,
): boolean {
  return thread.reads[0]?.muted ?? (bot ? !bot.notifyOnFinish : false);
}

export function hiddenFor(thread: { reads: Array<{ hidden: boolean }> }): boolean {
  return thread.reads[0]?.hidden ?? false;
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

/** A cleared chat has nothing left to read, for anyone. Snoozes, mutes and hides stay. */
export async function clearThreadReads(tx: Prisma.TransactionClient, threadId: string) {
  await runAsSystemInTransaction(
    tx,
    "clear every member's read state for a cleared chat",
    async () => {
      await tx.threadRead.deleteMany({
        where: { threadId, snoozedUntil: null, muted: null, hidden: false },
      });
      await tx.threadRead.updateMany({ where: { threadId }, data: { unread: false } });
    },
  );
}

/**
 * Marks the chat read up to its latest message for one person. Returns the seq they had read up
 * to before, or null when the chat wasn't unread for them or nothing new arrived; the first
 * answer of a visit places the "New" divider. The thread row is held so a message cannot land
 * between reading the latest seq and writing it.
 */
export function markThreadReadFor(prisma: PrismaClient, reader: Reader): Promise<number | null> {
  const { threadId, userId } = reader;
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const thread = await lockThread(tx, reader);
      if (!thread) return null;
      const latestSeq = thread.nextMessageSeq - 1;
      // Held until commit, so a Mark as Unread from another tab lands before or after, not lost.
      const [read] = await tx.$queryRaw<
        Array<{ unread: boolean; lastReadSeq: number; woke: boolean }>
      >`
        SELECT unread, "lastReadSeq", "snoozedUntil" <= now() AS woke FROM thread_reads
        WHERE "threadId" = ${threadId} AND "userId" = ${userId}
        FOR UPDATE`;
      if (!read || (!read.unread && !read.woke && read.lastReadSeq >= latestSeq)) return null;
      await tx.threadRead.update({
        where: { threadId_userId: { threadId, userId } },
        // Opening a chat that woke from a snooze ends the snooze.
        data: {
          unread: false,
          lastReadSeq: latestSeq,
          ...(read.woke ? { snoozedUntil: null } : {}),
        },
      });
      // A chat only gets a divider when its unread dot was on, so replies seen live never do.
      return read.unread && read.lastReadSeq < latestSeq ? read.lastReadSeq : null;
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
}

/** Holds the thread as markThreadReadFor does: a clear waits, and its seq is the latest. */
async function lockThread(tx: Prisma.TransactionClient, reader: Reader) {
  const [thread] = await tx.$queryRaw<Array<{ nextMessageSeq: number }>>`
    SELECT "nextMessageSeq" FROM threads
    WHERE id = ${reader.threadId} AND "spaceId" = ${reader.spaceId}
    FOR SHARE`;
  return thread;
}

/**
 * Marks the chat unread for one person from one of its messages: the divider goes above it.
 * False when the message is gone, such as after the chat was cleared.
 */
export function markThreadUnreadFromFor(
  prisma: PrismaClient,
  reader: Reader,
  messageId: string,
): Promise<boolean> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      if (!(await lockThread(tx, reader))) return false;
      const message = await tx.message.findFirst({
        where: { id: messageId, threadId: reader.threadId },
        select: { seq: true },
      });
      if (!message) return false;
      const state = { unread: true, lastReadSeq: message.seq - 1 };
      await tx.threadRead.upsert({
        where: { threadId_userId: { threadId: reader.threadId, userId: reader.userId } },
        create: { ...reader, ...state },
        update: state,
      });
      return true;
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
}

/** Mark as Read or Unread from the chat list, without moving where the divider goes. */
export async function setThreadUnreadFor(prisma: PrismaClient, reader: Reader, unread: boolean) {
  if (!unread) {
    await prisma.threadRead.updateMany({
      where: { threadId: reader.threadId, userId: reader.userId, unread: true },
      data: { unread: false },
    });
    return;
  }
  await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const thread = await lockThread(tx, reader);
      if (!thread) return;
      await tx.threadRead.upsert({
        where: { threadId_userId: { threadId: reader.threadId, userId: reader.userId } },
        // Someone with no read state had read it all.
        create: { ...reader, unread: true, lastReadSeq: thread.nextMessageSeq - 1 },
        update: { unread: true },
      });
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
}

/** Snoozes the chat for one person until `until`, or wakes it with null. */
export async function setThreadSnoozeFor(prisma: PrismaClient, reader: Reader, until: Date | null) {
  if (!until) {
    await prisma.threadRead.updateMany({
      where: { threadId: reader.threadId, userId: reader.userId },
      data: { snoozedUntil: null },
    });
    return;
  }
  await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const thread = await lockThread(tx, reader);
      if (!thread) return;
      await tx.threadRead.upsert({
        where: { threadId_userId: { threadId: reader.threadId, userId: reader.userId } },
        // Someone with no read state had read it all.
        create: { ...reader, lastReadSeq: thread.nextMessageSeq - 1, snoozedUntil: until },
        update: { snoozedUntil: until },
      });
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
}

/** Mutes the chat for one person, or unmutes it, whatever its bot's own setting says. */
export async function setThreadMuteFor(prisma: PrismaClient, reader: Reader, muted: boolean) {
  await upsertOwnState(prisma, reader, { muted });
}

/** Hides the chat from one person's list, or brings it back. */
export async function setThreadHiddenFor(prisma: PrismaClient, reader: Reader, hidden: boolean) {
  if (!hidden) {
    await prisma.threadRead.updateMany({
      where: { threadId: reader.threadId, userId: reader.userId, hidden: true },
      data: { hidden: false },
    });
    return;
  }
  await upsertOwnState(prisma, reader, { hidden });
}

async function upsertOwnState(
  prisma: PrismaClient,
  reader: Reader,
  state: { muted?: boolean; hidden?: boolean },
) {
  await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const thread = await lockThread(tx, reader);
      if (!thread) return;
      await tx.threadRead.upsert({
        where: { threadId_userId: { threadId: reader.threadId, userId: reader.userId } },
        // Someone with no read state had read it all.
        create: { ...reader, lastReadSeq: thread.nextMessageSeq - 1, ...state },
        update: state,
      });
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
}

/** What each of `userIds` set for a chat that holds its news back from them. */
export type ChatHold = { snoozed: boolean; hidden: boolean; muted: boolean | null };

/**
 * Each of `userIds` who snoozed, hid, muted or unmuted the chat; anyone missing never chose any
 * of it. Snoozes count only while they last.
 */
export async function chatHoldsFor(
  prisma: PrismaClient,
  threadId: string,
  userIds: readonly string[],
): Promise<Map<string, ChatHold>> {
  if (userIds.length === 0) return new Map();
  const now = new Date();
  const rows = await runAsSystem("find who snoozed, hid or muted a chat", () =>
    prisma.threadRead.findMany({
      where: {
        threadId,
        userId: { in: [...userIds] },
        OR: [{ snoozedUntil: { gt: now } }, { hidden: true }, { muted: { not: null } }],
      },
      select: { userId: true, snoozedUntil: true, hidden: true, muted: true },
    }),
  );
  return new Map(
    rows.map((row) => [
      row.userId,
      {
        snoozed: row.snoozedUntil !== null && row.snoozedUntil > now,
        hidden: row.hidden,
        muted: row.muted,
      },
    ]),
  );
}

/** Brings a chat one person hid back to their list, as when it needs them. */
export async function unhideChatFor(prisma: PrismaClient, threadId: string, userId: string) {
  await runAsSystem("bring a hidden chat back for a member", () =>
    prisma.threadRead.updateMany({
      where: { threadId, userId, hidden: true },
      data: { hidden: false },
    }),
  );
}

/** Whether this person muted a bot's own chat, its own setting deciding until they choose. */
export async function botChatMutedFor(
  prisma: PrismaClient,
  input: { botId: string; userId: string },
  bot: { notifyOnFinish: boolean },
): Promise<boolean> {
  const read = await prisma.threadRead.findFirst({
    where: { userId: input.userId, thread: { botId: input.botId } },
    select: { muted: true },
  });
  return mutedFor({ reads: read ? [read] : [] }, bot);
}

/**
 * A bot's `notifyOnFinish` as API callers and agents still set it: the caller's own mute of the
 * bot's chat. Saving the value already in effect records no choice, so a bot whose own switch is
 * off stays exactly as silent as before for whoever never chose.
 */
export async function setBotNotifyFor(
  prisma: PrismaClient,
  input: { botId: string; spaceId: string; userId: string },
  notify: boolean,
) {
  const thread = await prisma.thread.findUnique({
    where: { botId: input.botId },
    select: {
      id: true,
      bot: { select: { notifyOnFinish: true } },
      reads: { where: { userId: input.userId }, select: { muted: true } },
    },
  });
  if (!thread || mutedFor(thread, thread.bot) === !notify) return;
  await setThreadMuteFor(
    prisma,
    { threadId: thread.id, spaceId: input.spaceId, userId: input.userId },
    !notify,
  );
}
