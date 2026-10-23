import { GROUP_MEMBER_MIN } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { runAsSystem } from "./row-security.js";

/** Counts only the user's own chats in their member Spaces within the current organization. */
export function countUnreadInboxChats(
  prisma: PrismaClient,
  { userId, spaceId }: { userId: string; spaceId: string },
): Promise<number> {
  // Cross-Space RLS bypass is restricted to this user's memberships and owned chats.
  return runAsSystem("count unread inbox chats across the member's Spaces", async () => {
    const [result] = await prisma.$queryRaw<Array<{ count: number }>>`
      WITH member_spaces AS (
        SELECT m."spaceId" FROM space_members m
        JOIN spaces s ON s.id = ${spaceId} AND s."organizationId" = m."organizationId"
        WHERE m."userId" = ${userId}
      )
      SELECT count(*)::int AS count FROM threads t
      JOIN member_spaces m ON m."spaceId" = t."spaceId"
      WHERE t.unread AND t."userId" = ${userId}
        AND t."externalConversationId" IS NULL
        AND (
          EXISTS (SELECT 1 FROM bots b WHERE b.id = t."botId"
            AND b."spaceId" = t."spaceId" AND b."userId" = ${userId} AND b."archivedAt" IS NULL)
          OR EXISTS (SELECT 1 FROM chat_groups g WHERE g.id = t."groupId"
            AND g."spaceId" = t."spaceId" AND g."userId" = ${userId} AND g."archivedAt" IS NULL
            AND (SELECT count(*) FROM chat_group_members gm JOIN bots b ON b.id = gm."botId"
              WHERE gm."groupId" = g.id AND b."archivedAt" IS NULL) >= ${GROUP_MEMBER_MIN})
        )`;
    return result?.count ?? 0;
  });
}
