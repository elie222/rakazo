import { displayName, inferBotRoleRename } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { writeBotInstructions } from "./bot-instructions.js";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";

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
  if (
    !options.emitBotUpdated &&
    options.data.instructions === undefined &&
    !options.instructionRestore
  ) {
    return options.prisma.bot.update({
      where: { id: options.botId, ...options.expectedModel },
      data: options.data,
      select: { id: true, name: true, title: true, description: true },
    });
  }

  let { instructions, ...data } = options.data;
  const committed = await options.prisma.$transaction(async (tx) => {
    // Event appends also lock the thread; all writers take it before the bot row.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${options.threadId} FOR UPDATE`;
    // Only names with a recognized meaning get role defaults. Preserve user
    // edits and any explicit title/description/instructions in the same update.
    // Read under the thread lock and write instructions via version history.
    if (
      process.env.RAKAZO_BOT_ROLE_AUTOFILL === "true" &&
      typeof data.name === "string" &&
      !options.instructionRestore
    ) {
      // The thread lock protects direct chat writes, but instruction approval
      // can originate in another thread. Serialize every inference read with
      // all instruction writers by locking the bot row before observing it.
      await tx.$queryRaw`SELECT id FROM bots WHERE id = ${options.botId} FOR UPDATE`;
      const current = await tx.bot.findUnique({
        where: { id: options.botId },
        select: { name: true, title: true, description: true, instructions: true },
      });
      if (current) {
        const generated = inferBotRoleRename(current, data.name, {
          title: data.title,
          description: data.description,
          instructions,
        });
        if (generated.title !== undefined) data = { ...data, title: generated.title };
        if (generated.description !== undefined)
          data = { ...data, description: generated.description };
        if (generated.instructions !== undefined) instructions = generated.instructions;
      }
    }
    if (typeof instructions === "string" || options.instructionRestore) {
      await writeBotInstructions(tx, {
        botId: options.botId,
        instructions,
        reason: options.instructionRestore
          ? "Restore"
          : (options.reason ?? "Manual or automatic profile edit"),
        expectedInstructions: options.expectedInstructions,
        ...options.instructionRestore,
      });
    }
    const updated = await tx.bot.update({
      where: { id: options.botId, ...options.expectedModel },
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
