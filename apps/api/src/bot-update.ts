import type { Prisma, PrismaClient } from "@rakazo/db";
import { appendEventInTransaction, writeBotInstructions } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

type AppendEvent = typeof appendEventInTransaction;

/**
 * Persist a bot row. When profile labels change, write `bot.updated` in the same
 * transaction so clients never observe a successful rename without a durable event.
 * Realtime notify stays best-effort after commit.
 */
export async function commitBotUpdate(
  options: {
    prisma: PrismaClient;
    notify: (threadId: string, seq: number) => Promise<void>;
    spaceId: string;
    threadId: string;
    botId: string;
    data: Omit<Prisma.BotUncheckedUpdateInput, "instructions"> & { instructions?: string };
    emitBotUpdated: boolean;
  },
  appendEvent: AppendEvent = appendEventInTransaction,
): Promise<{ id: string; name: string; title: string; description: string }> {
  if (!options.emitBotUpdated && options.data.instructions === undefined) {
    return options.prisma.bot.update({
      where: { id: options.botId },
      data: options.data,
      select: { id: true, name: true, title: true, description: true },
    });
  }

  const { instructions, ...data } = options.data;
  const committed = await options.prisma.$transaction(async (tx) => {
    if (typeof instructions === "string") {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${options.threadId} FOR UPDATE`;
      await writeBotInstructions(tx, {
        botId: options.botId,
        instructions,
        reason: "Manual edit",
      });
    }
    const updated = await tx.bot.update({
      where: { id: options.botId },
      data,
      select: { id: true, name: true, title: true, description: true },
    });
    const event = await appendEvent(tx, {
      spaceId: options.spaceId,
      threadId: options.threadId,
      botId: options.botId,
      type: "bot.updated",
      payload: {
        botId: updated.id,
        name: updated.name,
        title: updated.title,
        description: updated.description,
      },
    });
    return { updated, seq: event.seq };
  });

  await options.notify(options.threadId, committed.seq).catch((error) => {
    getLogger().error("bot.updated realtime notification", error);
  });
  return committed.updated;
}

export function botProfileLabelsChanged(input: {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  color?: unknown;
}): boolean {
  return (
    input.name !== undefined ||
    input.title !== undefined ||
    input.description !== undefined ||
    input.color !== undefined
  );
}
