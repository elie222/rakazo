import { displayName } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { writeBotInstructions } from "./bot-instructions.js";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";

type AppendEvent = typeof appendEventInTransaction;

/**
 * When profile labels or instructions change, write `bot.updated` in the same
 * transaction so clients can refresh after every successful write.
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
    expectedInstructions?: string;
    expectedModel?: {
      modelProvider: string | null;
      modelId: string | null;
      thinkingLevel: string | null;
    };
    instructionRestore?: { versionId: string; undo?: boolean };
    reason?: string;
  },
  appendEvent: AppendEvent = appendEventInTransaction,
): Promise<{ id: string; name: string; description: string }> {
  if (typeof options.data.name === "string") {
    options = {
      ...options,
      data: { ...options.data, name: displayName(options.data.name, "") },
    };
  }
  if (
    !options.emitBotUpdated &&
    options.data.instructions === undefined &&
    !options.instructionRestore
  ) {
    return options.prisma.bot.update({
      where: { id: options.botId, ...options.expectedModel },
      data: options.data,
      select: { id: true, name: true, description: true },
    });
  }

  const { instructions, ...data } = options.data;
  const committed = await options.prisma.$transaction(async (tx) => {
    // Event appends also lock the thread; all writers take it before the bot row.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${options.threadId} FOR UPDATE`;
    if (typeof instructions === "string" || options.instructionRestore) {
      await writeBotInstructions(tx, {
        botId: options.botId,
        instructions,
        reason: options.instructionRestore ? "Restore" : (options.reason ?? "Manual edit"),
        expectedInstructions: options.expectedInstructions,
        ...options.instructionRestore,
      });
    }
    const updated = await tx.bot.update({
      where: { id: options.botId, ...options.expectedModel },
      data,
      select: { id: true, name: true, description: true },
    });
    const event = await appendEvent(tx, {
      spaceId: options.spaceId,
      threadId: options.threadId,
      botId: options.botId,
      type: "bot.updated",
      payload: {
        botId: updated.id,
        name: updated.name,
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
  description?: unknown;
  color?: unknown;
  avatarSet?: unknown;
}): boolean {
  return (
    input.name !== undefined ||
    input.description !== undefined ||
    input.color !== undefined ||
    input.avatarSet !== undefined
  );
}
