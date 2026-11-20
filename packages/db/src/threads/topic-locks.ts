import type { Prisma } from "../generated/prisma/client.js";

/**
 * Locks every topic under a chat's messages and returns their ids. Taken while the chat itself is
 * locked, by work that deletes the chat's messages and so their topics.
 */
export async function lockChatTopics(
  tx: Prisma.TransactionClient,
  mainThreadId: string,
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT t.id FROM threads t JOIN messages m ON m.id = t."parentMessageId"
    WHERE m."threadId" = ${mainThreadId}
    ORDER BY t.id FOR UPDATE OF t`;
  return rows.map((row) => row.id);
}
