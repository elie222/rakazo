import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { CONNECTED_RUN_NONCE_PREFIX } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";

/** Connecting from a card in a chat is the user's turn: queue a hidden-prompt run (like a call's
    hang-up) so the bot carries on with the new tools instead of waiting for another message.
    Queued even while the bot is busy in that chat, since the card flips once and nothing would
    ask again; its nonce marks it to wait for that chat to be free (see chat-wait).
    Skipped when the bot is no longer in the chat or archived along with it.
    Returns the run to wake once the transaction commits. */
export async function queueConnectedRun(
  tx: Prisma.TransactionClient,
  actor: Actor,
  input: { botId: string; threadId: string; prompt: string },
): Promise<string | null> {
  const thread = await tx.thread.findFirst({
    where: {
      id: input.threadId,
      spaceId: actor.spaceId,
      OR: [
        { botId: input.botId },
        { group: { archivedAt: null, members: { some: { botId: input.botId } } } },
        // A topic, which opens only in the bot's own chat.
        { parentMessage: { is: { thread: { botId: input.botId } } } },
      ],
    },
    select: { id: true },
  });
  if (!thread) return null;
  const bot = await tx.bot.findFirst({
    where: { id: input.botId, spaceId: actor.spaceId, archivedAt: null },
    select: { id: true },
  });
  if (!bot) return null;
  const task = await tx.task.create({
    data: {
      spaceId: actor.spaceId,
      botId: input.botId,
      threadId: thread.id,
      userId: actor.userId,
      prompt: input.prompt,
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: actor.spaceId,
      botId: input.botId,
      threadId: thread.id,
      taskId: task.id,
      userId: actor.userId,
      status: "queued",
      trigger: "user",
      clientNonce: `${CONNECTED_RUN_NONCE_PREFIX}${randomUUID()}`,
    },
    select: { id: true },
  });
  return run.id;
}
