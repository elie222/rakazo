import type { PrismaClient } from "@rakazo/db";

/**
 * The thread a routine runs in when it is not the bot's own chat: the group chat it was made in,
 * while that group is not archived and the bot is still a member. Null means the bot's own thread.
 * A scheduled tick and Run now both ask this, so they always pick the same chat.
 */
export async function routineGroupThreadId(
  prisma: Pick<PrismaClient, "thread">,
  routine: { threadId: string | null; spaceId: string },
  botId: string,
): Promise<string | null> {
  if (!routine.threadId) return null;
  const thread = await prisma.thread.findFirst({
    where: {
      id: routine.threadId,
      spaceId: routine.spaceId,
      OR: [{ botId }, { group: { archivedAt: null, members: { some: { botId } } } }],
    },
    select: { id: true },
  });
  return thread?.id ?? null;
}
