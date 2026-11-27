import type { PrismaClient } from "../database/client.js";
import { THREAD_LOCK_TRANSACTION_OPTIONS } from "../threads/events.js";

/**
 * Change the owner's stored runtime preference without changing the bot identity or chat.
 * Like native snapshot preparation and completion, lock the owner's DM before touching the bot.
 * A stale writer cannot resurrect a selection, even if the choice has changed back.
 */
export async function setBotPrimaryRuntimePreference(
  prisma: PrismaClient,
  input: {
    botId: string;
    spaceId: string;
    userId: string;
    preference: string | null;
    expectedRevision: number;
  },
) {
  const { botId, spaceId, userId, preference, expectedRevision } = input;
  return prisma.$transaction(async (tx) => {
    const [thread] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM threads
      WHERE "botId" = ${botId} AND "spaceId" = ${spaceId} AND "userId" = ${userId}
        AND "groupId" IS NULL AND "externalConversationId" IS NULL AND "helperBotId" IS NULL
      FOR UPDATE`;
    if (!thread) return { status: "not_found" as const };
    const where = { id: botId, spaceId, userId, archivedAt: null };
    const current = await tx.bot.findFirst({
      where,
      select: { primaryRuntimePreference: true, primaryRuntimeRevision: true },
    });
    if (!current) return { status: "not_found" as const };
    if (current.primaryRuntimeRevision !== expectedRevision) return { status: "conflict" as const };
    if (current.primaryRuntimePreference === preference)
      return { status: "unchanged" as const, revision: expectedRevision };

    const revision = expectedRevision + 1;
    const changed = await tx.bot.updateMany({
      where: { ...where, primaryRuntimeRevision: expectedRevision },
      data: { primaryRuntimePreference: preference, primaryRuntimeRevision: revision },
    });
    if (changed.count !== 1) return { status: "conflict" as const };
    await tx.nativeDmSession.deleteMany({ where: { threadId: thread.id, spaceId, userId } });
    return { status: "changed" as const, revision };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
}
