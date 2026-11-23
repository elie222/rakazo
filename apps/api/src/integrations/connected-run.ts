import type { Actor } from "@rakazo/contracts";
import { QUEUE_HOLDING_RUN_STATUSES } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import { HOLDS_CHAT } from "@rakazo/db";

/** Connecting from a card in a chat is the user's turn: queue a hidden-prompt run (like
    a call's hang-up) so the bot carries on with the new tools instead of waiting for
    another message. Skipped while the bot is busy in that chat, no longer in it, or
    archived along with the chat. Returns the run to wake once the transaction commits. */
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
      ],
    },
    select: { id: true },
  });
  if (!thread) return null;
  const [bot, busy] = await Promise.all([
    tx.bot.findFirst({
      where: { id: input.botId, spaceId: actor.spaceId, archivedAt: null },
      select: { id: true },
    }),
    tx.run.findFirst({
      where: {
        threadId: thread.id,
        botId: input.botId,
        status: { in: [...QUEUE_HOLDING_RUN_STATUSES] },
        ...HOLDS_CHAT,
      },
      select: { id: true },
    }),
  ]);
  if (!bot || busy) return null;
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
    },
    select: { id: true },
  });
  return run.id;
}
