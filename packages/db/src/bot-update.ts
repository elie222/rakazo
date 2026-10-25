import { displayName } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { writeBotInstructions } from "./bot-instructions.js";
import { Prisma, type PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { lockSpaceMemoryScope } from "./spaces.js";

type AppendEvent = typeof appendEventInTransaction;

/**
 * Persist a bot row. When profile labels or instructions change, write `bot.updated`
 * in the same transaction so clients can refresh after every successful write.
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
    /** Runs under the Space scope lock, before any thread or bot row lock. */
    beforeWrite?: (tx: Prisma.TransactionClient) => Promise<void>;
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
): Promise<{ id: string; name: string; title: string; description: string }> {
  if (typeof options.data.name === "string") {
    options = {
      ...options,
      data: { ...options.data, name: displayName(options.data.name, "") },
    };
  }
  const scopeWrite = options.data.memoryScope !== undefined;
  const needsEvent =
    options.emitBotUpdated ||
    options.data.instructions !== undefined ||
    Boolean(options.instructionRestore);
  if (!scopeWrite && !options.beforeWrite && !needsEvent) {
    return options.prisma.bot.update({
      where: { id: options.botId, ...options.expectedModel },
      data: options.data,
      select: { id: true, name: true, title: true, description: true },
    });
  }

  const { instructions, ...data } = options.data;
  const committed = await options.prisma.$transaction(
    async (tx) => {
      if (scopeWrite || options.beforeWrite) {
        await lockSpaceMemoryScope(tx, options.spaceId);
        await options.beforeWrite?.(tx);
      }
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
        select: { id: true, name: true, title: true, description: true },
      });
      if (!needsEvent) return { updated, seq: undefined };
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
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );

  if (committed.seq !== undefined) {
    await options.notify(options.threadId, committed.seq).catch((error) => {
      getLogger().error("bot.updated realtime notification", error);
    });
  }
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
