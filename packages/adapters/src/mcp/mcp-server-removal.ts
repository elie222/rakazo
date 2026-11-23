import type { MessageBlock } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";
import { appendEventInTransaction, changeMessageBlocks } from "@rakazo/db";

type OwnerScope = { spaceId: string; userId: string };
type ApprovalBlock = Extract<MessageBlock, { kind: "mcp_approval" }>;

function isApproval(block: MessageBlock, serverId: string): block is ApprovalBlock {
  return block.kind === "mcp_approval" && block.serverId === serverId;
}

/** Closes every approval card for the server, including cards that were never assigned. */
export async function dismissMcpServerApprovals(
  tx: Prisma.TransactionClient,
  scope: OwnerScope,
  serverId: string,
): Promise<Array<{ threadId: string; seq: number }>> {
  const messages = await tx.message.findMany({
    where: {
      thread: { spaceId: scope.spaceId },
      blocks: { array_contains: [{ kind: "mcp_approval", serverId }] },
    },
    select: {
      id: true,
      botId: true,
      blocks: true,
      threadId: true,
      thread: { select: { botId: true } },
    },
  });
  const seqs: Array<{ threadId: string; seq: number }> = [];
  for (const message of messages) {
    const next = changeMessageBlocks(message, (block) =>
      isApproval(block, serverId) && block.status !== "dismissed"
        ? { ...block, status: "dismissed" as const }
        : block,
    );
    if (!next) continue;
    await tx.message.update({ where: { id: message.id }, data: { blocks: next.stored } });
    const eventBotId = message.botId ?? message.thread?.botId;
    if (!eventBotId) continue;
    const event = await appendEventInTransaction(tx, {
      spaceId: scope.spaceId,
      threadId: message.threadId,
      botId: eventBotId,
      type: "thread.message.updated",
      payload: { messageId: message.id, role: "bot", blocks: next.blocks },
    });
    seqs.push({ threadId: message.threadId, seq: event.seq });
  }
  return seqs;
}

/** Deletes a server with its credential and closes its cards. Assignments cascade.
 * Returns the thread events to notify once the transaction commits. */
export async function removeMcpServerInTransaction(
  tx: Prisma.TransactionClient,
  scope: OwnerScope,
  server: { id: string; secretId: string | null },
): Promise<Array<{ threadId: string; seq: number }>> {
  const seqs = await dismissMcpServerApprovals(tx, scope, server.id);
  await tx.mcpServer.delete({ where: { id: server.id } });
  // The credential may sit in the server's home space, not the one removing it.
  if (server.secretId) {
    await tx.secret.deleteMany({ where: { id: server.secretId, userId: scope.userId } });
  }
  return seqs;
}
