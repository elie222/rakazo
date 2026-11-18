import type { MessageBlock } from "@rakazo/contracts";
import { BOT_MESSAGE_MAX_LENGTH, BOT_MESSAGE_TOO_LONG } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  assertRunCanWriteHistory,
  createThreadMessageInTransaction,
  IsolationError,
  isUniqueViolation,
  lockSpaceGroup,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  touchGroupUpdatedAt,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { runLeaseFor } from "../runs/assembly/run-messages.js";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";

type PostingRun = { id: string; spaceId: string; threadId: string; botId: string };

/**
 * A group the bot belongs to, by id or exact name, other than the one this run is in: there the
 * bot's reply already lands in the group.
 */
export async function findPostableGroup(
  prisma: PrismaClient,
  run: PostingRun,
  ref: { groupId?: string; groupName?: string },
): Promise<{ error: string } | { id: string; name: string }> {
  if (ref.groupId && ref.groupName) return { error: "pass group_id or group_name, not both" };
  if (!ref.groupId && !ref.groupName) return { error: "pass group_id or group_name" };
  const named = {
    spaceId: run.spaceId,
    archivedAt: null,
    thread: { isNot: null },
    ...(ref.groupId ? { id: ref.groupId } : { name: ref.groupName }),
  };
  const joined = await prisma.chatGroup.findMany({
    where: { ...named, members: { some: { botId: run.botId, bot: { archivedAt: null } } } },
    select: { id: true, name: true, thread: { select: { id: true } } },
    take: 2,
  });
  if (joined.length > 1) {
    return { error: `more than one of your groups is named "${ref.groupName}"; pass group_id` };
  }
  if (!joined.length) {
    const exists = await prisma.chatGroup.findFirst({ where: named, select: { id: true } });
    if (exists) return { error: "you are not a member of that group" };
    return {
      error: ref.groupId ? "no group with that id" : `no group named "${ref.groupName}"`,
    };
  }
  const group = joined[0]!;
  if (group.thread?.id === run.threadId) {
    return { error: "you are already in this group; reply here instead" };
  }
  return { id: group.id, name: group.name };
}

/**
 * Posts a message into a group as the bot's own message. It starts no member: a bot's message in a
 * group never wakes the others, and handoff_to_bot is how a bot asks one to act. Replaying the same
 * delivery key returns the first post.
 */
export async function postToGroup(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "runLease">,
  run: PostingRun,
  group: { id: string; name: string },
  input: {
    message: string;
    deliveryKey?: string;
    /** Saved attachments shown with the post. */
    files?: Array<Extract<MessageBlock, { kind: "image" | "file" }>>;
  },
): Promise<{ error: string } | { ok: true; group: string; messageId: string; note: string }> {
  const text = input.message.trim();
  if (!text) return { error: "message is required" };
  if (text.length > BOT_MESSAGE_MAX_LENGTH) return { error: BOT_MESSAGE_TOO_LONG };
  const clientNonce = input.deliveryKey ? `group-post:${input.deliveryKey}` : undefined;
  const posted = (messageId: string) => ({
    ok: true as const,
    group: group.name,
    messageId,
    note: `Posted in ${group.name}. It started no member.`,
  });

  let committed: { error: string } | { messageId: string; threadId: string; eventSeq?: number };
  try {
    committed = await deps.prisma.$transaction(async (tx) => {
      try {
        await lockSpaceGroup(tx, run, group.id);
      } catch (error) {
        if (error instanceof IsolationError) return { error: "that group is no longer available" };
        throw error;
      }
      const current = await tx.chatGroup.findFirst({
        where: { id: group.id, spaceId: run.spaceId, archivedAt: null },
        select: {
          thread: { select: { id: true } },
          members: { where: { botId: run.botId, bot: { archivedAt: null } }, select: { id: true } },
        },
      });
      if (!current?.thread) return { error: "that group is no longer available" };
      if (!current.members.length) return { error: "you are not a member of that group" };
      const threadId = current.thread.id;
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      if (clientNonce) {
        const existing = await tx.message.findUnique({
          where: { threadId_clientNonce: { threadId, clientNonce } },
          select: { id: true },
        });
        if (existing) return { messageId: existing.id, threadId };
      }
      // A superseded or ended attempt posts nothing.
      await assertRunCanWriteHistory(tx, run.id, { lease: runLeaseFor(deps, run.id) });
      const blocks: MessageBlock[] = [{ kind: "text", text }, ...(input.files ?? [])];
      const message = await createThreadMessageInTransaction(tx, {
        threadId,
        role: "bot",
        blocks,
        botId: run.botId,
        clientNonce,
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId,
        botId: run.botId,
        type: "thread.message.created",
        payload: { messageId: message.id, role: "bot", blocks },
      });
      await touchGroupUpdatedAt(tx, group.id);
      return { messageId: message.id, threadId, eventSeq: event.seq };
    }, THREAD_LOCK_TRANSACTION_OPTIONS);
  } catch (error) {
    // Two concurrent retries can both miss the lookup; the loser hits the unique key.
    if (clientNonce && isUniqueViolation(error)) {
      const winner = await deps.prisma.message.findFirst({
        where: { clientNonce, thread: { groupId: group.id } },
        select: { id: true },
      });
      if (winner) return posted(winner.id);
    }
    throw error;
  }
  if ("error" in committed) return committed;
  if (committed.eventSeq !== undefined) {
    await bestEffort(
      "group post realtime notification",
      deps.events.notify(committed.threadId, committed.eventSeq),
    );
  }
  return posted(committed.messageId);
}
