import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, THREAD_LOCK_TRANSACTION_OPTIONS } from "@rakazo/db";
import type { ThreadTarget } from "./thread-target.js";

/**
 * Marks the thread read up to its latest message. Returns the seq the user had read up
 * to before, or null when the chat wasn't unread or nothing new arrived; the first
 * answer of a visit places the "New" divider. A message landing mid-update makes the
 * conditional write miss, so it retries rather than marking that message read; a chat
 * that stays that busy is read under the thread's row lock instead.
 */
export async function markThreadRead(
  prisma: PrismaClient,
  actor: Actor,
  target: ThreadTarget,
): Promise<number | null> {
  const where = { id: target.threadId, spaceId: actor.spaceId };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const thread = await prisma.thread.findFirst({
      where,
      select: { unread: true, lastReadSeq: true, nextMessageSeq: true },
    });
    if (!thread) return null;
    const latestSeq = thread.nextMessageSeq - 1;
    if (!thread.unread && thread.lastReadSeq >= latestSeq) return null;
    const result = await prisma.thread.updateMany({
      where: { ...where, lastReadSeq: thread.lastReadSeq, nextMessageSeq: thread.nextMessageSeq },
      data: { unread: false, lastReadSeq: latestSeq },
    });
    if (result.count > 1) throw new IsolationError();
    if (result.count === 1) return dividerSeq(thread, latestSeq);
  }
  // New messages take the same row lock, so none can land between this read and write.
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
    const thread = await tx.thread.findFirst({
      where,
      select: { unread: true, lastReadSeq: true, nextMessageSeq: true },
    });
    if (!thread) return null;
    const latestSeq = thread.nextMessageSeq - 1;
    if (!thread.unread && thread.lastReadSeq >= latestSeq) return null;
    const result = await tx.thread.updateMany({
      where,
      data: { unread: false, lastReadSeq: latestSeq },
    });
    if (result.count > 1) throw new IsolationError();
    return dividerSeq(thread, latestSeq);
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
}

/** A chat only gets a divider when its unread dot was on, so replies seen live never do. */
function dividerSeq(thread: { unread: boolean; lastReadSeq: number }, latestSeq: number) {
  return thread.unread && thread.lastReadSeq < latestSeq ? thread.lastReadSeq : null;
}

/**
 * Marks the thread unread from one of its messages: the read cursor moves to just before it,
 * so the next open puts the New divider above that message.
 */
export async function markThreadUnreadFrom(
  prisma: PrismaClient,
  actor: Actor,
  target: ThreadTarget,
  messageId: string,
) {
  const message = await prisma.message.findFirst({
    where: { id: messageId, threadId: target.threadId },
    select: { seq: true },
  });
  if (!message) throw new ORPCError("NOT_FOUND");
  const result = await prisma.thread.updateMany({
    where: { id: target.threadId, spaceId: actor.spaceId },
    data: { unread: true, lastReadSeq: message.seq - 1 },
  });
  if (result.count > 1) throw new IsolationError();
}

export async function setThreadUnreadState(
  prisma: PrismaClient,
  actor: Actor,
  target: ThreadTarget,
  unread: boolean,
) {
  const result = await prisma.thread.updateMany({
    where: {
      id: target.threadId,
      spaceId: actor.spaceId,
      unread: { not: unread },
    },
    data: { unread },
  });
  if (result.count > 1) throw new IsolationError();
}
