import type { ComputerMode } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { computerChangedNote } from "./computer-change.prompt.js";

/**
 * Leaves one system note in the bot's thread saying it moved to another computer. Like every
 * system note it reaches the bot through the thread history, so its next turn reads it once.
 */
export async function announceComputerChange(
  deps: { prisma: PrismaClient; events: ThreadEvents },
  bot: { id: string; spaceId: string; threadId: string },
  change: { from: ComputerMode; to: ComputerMode; files?: "copied" | "stayed" },
): Promise<void> {
  const blocks = [
    { kind: "meta" as const, text: computerChangedNote(change.from, change.to, change.files) },
  ];
  const seq = await deps.prisma.$transaction(async (tx) => {
    const message = await createThreadMessageInTransaction(tx, {
      threadId: bot.threadId,
      botId: bot.id,
      role: "system",
      blocks,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: bot.spaceId,
      threadId: bot.threadId,
      botId: bot.id,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "system", blocks },
    });
    return event.seq;
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  await bestEffort("computer change note signal", deps.events.notify(bot.threadId, seq));
}
