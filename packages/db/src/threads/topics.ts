import type { MessageBlock, TopicSummary } from "@rakazo/contracts";
import { topicSettledBy, topicTitle } from "@rakazo/core";
import { isUniqueViolation } from "../database/prisma-errors.js";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { appendEventInTransaction, THREAD_LOCK_TRANSACTION_OPTIONS } from "./events.js";
import { storedMessageBlocks } from "./message-blocks.js";
import type { RunLease } from "./messages.js";
import { assertRunCanWriteHistory, createThreadMessageInTransaction } from "./messages.js";
import { markThreadUnreadForMembers } from "./thread-reads.js";

/** How many of a chat's topics its list reads, newest first. */
const TOPIC_LIST_LIMIT = 200;

/**
 * The topic replying to a message in a bot chat, started the first time someone opens it.
 * Null when the message is not in that chat.
 */
export async function openTopic(
  prisma: PrismaClient,
  input: { mainThreadId: string; messageId: string },
): Promise<string | null> {
  const message = await prisma.message.findFirst({
    where: { id: input.messageId, threadId: input.mainThreadId },
    select: { id: true, thread: { select: { spaceId: true, userId: true } } },
  });
  if (!message) return null;
  const existing = () =>
    prisma.thread.findUnique({ where: { parentMessageId: message.id }, select: { id: true } });
  const found = await existing();
  if (found) return found.id;
  try {
    return await prisma.$transaction(async (tx) => {
      // Shares the chat's lock, so a clear or prune that holds it sees this topic or outlasts it.
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.mainThreadId} FOR SHARE`;
      const root = await tx.message.findUnique({ where: { id: message.id }, select: { id: true } });
      if (!root) return null;
      const created = await tx.thread.create({
        data: {
          spaceId: message.thread.spaceId,
          userId: message.thread.userId,
          parentMessageId: message.id,
        },
        select: { id: true },
      });
      return created.id;
    }, THREAD_LOCK_TRANSACTION_OPTIONS);
  } catch (error) {
    // Two opens of the same message at once: the other one started it.
    if (!isUniqueViolation(error)) throw error;
    return (await existing())?.id ?? null;
  }
}

/** A topic in the bot chat `mainThreadId`; null when it belongs to another chat. */
export async function findTopic(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: { mainThreadId: string; topicId: string },
) {
  return prisma.thread.findFirst({
    where: { id: input.topicId, parentMessage: { threadId: input.mainThreadId } },
    select: { id: true, spaceId: true, parentMessageId: true },
  });
}

/** Marks a topic done by its viewer or the bot, or open again with `by: null`. */
export async function settleTopic(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: { topicId: string; by: "user" | "bot" | null; now?: Date },
): Promise<void> {
  // A reopen keeps its time, so the topic stays open a full week before it settles from quiet.
  await prisma.thread.update({
    where: { id: input.topicId },
    data: { settledAt: input.now ?? new Date(), settledBy: input.by },
  });
}

/**
 * A bot chat's topics for one viewer, newest activity first. A topic someone opened but nobody
 * replied in is left out; one the bot posted as an item is listed from the start.
 */
export async function listTopics(
  prisma: PrismaClient,
  input: { mainThreadId: string; userId: string; now?: Date },
): Promise<TopicSummary[]> {
  const topics = await prisma.thread.findMany({
    where: {
      parentMessage: { threadId: input.mainThreadId },
      OR: [{ item: true }, { nextMessageSeq: { gt: 0 } }],
    },
    orderBy: { createdAt: "desc" },
    take: TOPIC_LIST_LIMIT,
    select: {
      id: true,
      item: true,
      createdAt: true,
      settledAt: true,
      settledBy: true,
      parentMessage: { select: { id: true, blocks: true } },
      reads: { where: { userId: input.userId }, select: { unread: true } },
    },
  });
  if (!topics.length) return [];
  const activity = await prisma.message.groupBy({
    by: ["threadId"],
    where: { threadId: { in: topics.map((topic) => topic.id) } },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  const byThread = new Map(activity.map((row) => [row.threadId, row]));
  const now = input.now ?? new Date();
  return topics
    .flatMap((topic) => {
      const root = topic.parentMessage;
      if (!root) return [];
      const row = byThread.get(topic.id);
      const lastActivityAt = row?._max.createdAt ?? topic.createdAt;
      const unread = topic.reads[0]?.unread ?? false;
      const reopenedAt = topic.settledBy === null ? topic.settledAt : null;
      const quietSince = reopenedAt && reopenedAt > lastActivityAt ? reopenedAt : lastActivityAt;
      return [
        {
          id: topic.id,
          rootMessageId: root.id,
          title: topicTitle({ blocks: storedMessageBlocks(root) }),
          item: topic.item,
          replyCount: row?._count._all ?? 0,
          lastActivityAt: lastActivityAt.toISOString(),
          unread,
          settledBy: topicSettledBy({ settledBy: topic.settledBy, unread, quietSince }, now),
        },
      ];
    })
    .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
}

/** The message a topic replies to, from the bot chat; null for any other thread. */
export async function loadTopicRoot(prisma: PrismaClient, threadId: string) {
  const topic = await prisma.thread.findUnique({
    where: { id: threadId },
    select: {
      parentMessage: {
        select: {
          id: true,
          threadId: true,
          seq: true,
          role: true,
          botId: true,
          authorUserId: true,
          blocks: true,
          createdAt: true,
        },
      },
    },
  });
  return topic?.parentMessage ?? null;
}

/**
 * The bot posts a message in its chat that opens a topic straight away, listed as open until
 * someone settles it. It reads as unread to everyone, so it never settles from quiet unseen.
 * Replaying the same `effectKey` returns the first post.
 */
export async function postTopicItem(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    mainThreadId: string;
    userId: string;
    botId: string;
    runId: string;
    lease?: RunLease;
    text: string;
    effectKey: string;
  },
): Promise<{ messageId: string; topicId: string; eventSeq: number | null }> {
  const clientNonce = `item:${input.effectKey}`;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.mainThreadId} FOR UPDATE`;
    const posted = await tx.message.findUnique({
      where: { threadId_clientNonce: { threadId: input.mainThreadId, clientNonce } },
      select: { id: true, topic: { select: { id: true } } },
    });
    if (posted?.topic) return { messageId: posted.id, topicId: posted.topic.id, eventSeq: null };
    // Only this turn's live worker may post, but the post is not part of its reply.
    await assertRunCanWriteHistory(tx, input.runId, { lease: input.lease });
    const blocks: MessageBlock[] = [{ kind: "text", text: input.text }];
    const message = await createThreadMessageInTransaction(tx, {
      threadId: input.mainThreadId,
      role: "bot",
      blocks,
      botId: input.botId,
      clientNonce,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.mainThreadId,
      botId: input.botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    const topic = await tx.thread.create({
      data: {
        spaceId: input.spaceId,
        userId: input.userId,
        parentMessageId: message.id,
        item: true,
      },
      select: { id: true },
    });
    await markThreadUnreadForMembers(tx, { threadId: topic.id, spaceId: input.spaceId, seq: 0 });
    return { messageId: message.id, topicId: topic.id, eventSeq: event.seq };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
}
