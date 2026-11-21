import type { MessageBlock } from "@rakazo/contracts";
import { McpTransportSchema } from "@rakazo/contracts";
import type { McpServer, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  storedMessageBlocks,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { McpReauthorizationRequiredError } from "./mcp-oauth.js";

const RECENT_MESSAGES = 50;

/** Whether a failure means the server's stored sign-in is gone and only the user can renew it. */
export function needsMcpReauthorization(error: unknown, depth = 0): boolean {
  if (depth > 5 || !(error instanceof Error)) return false;
  if (error instanceof McpReauthorizationRequiredError) return true;
  const inner = error instanceof AggregateError ? error.errors : [error.cause];
  return inner.some((cause) => needsMcpReauthorization(cause, depth + 1));
}

/**
 * A run that loses a server to an expired sign-in still ends `completed`, so nothing tells the
 * user. Leave the chat's own authorization card for the server, the one an agent-added server
 * gets, so they can sign in again from where the bot works. One card per outage: while the
 * newest card for the server in the recent chat is still open, or the user answered it with
 * Not now, no other is posted.
 */
export async function postMcpReconnectCard(
  deps: { prisma: PrismaClient; events: Pick<ThreadEvents, "notify"> },
  ids: { runId: string; botId: string },
  server: Pick<McpServer, "id" | "name" | "transport" | "endpoint">,
): Promise<boolean> {
  const found = await deps.prisma.run.findUnique({
    where: { id: ids.runId },
    select: { threadId: true, spaceId: true },
  });
  if (!found) return false;
  const run = { id: ids.runId, botId: ids.botId, ...found };
  const transport = McpTransportSchema.safeParse(server.transport);
  if (!transport.success) return false;
  const block: MessageBlock = {
    kind: "mcp_approval",
    name: server.name,
    serverId: server.id,
    transport: transport.data,
    endpoint: server.endpoint,
    needsOAuth: true,
    status: "pending",
  };
  const committed = await deps.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
    const nonce = `mcp-reconnect:${server.id}:${run.id}`;
    const replayed = await tx.message.findFirst({
      where: { threadId: run.threadId, clientNonce: nonce },
      select: { id: true },
    });
    if (replayed) return null;
    const recent = await tx.message.findMany({
      where: { threadId: run.threadId },
      select: { id: true, blocks: true },
      orderBy: { createdAt: "desc" },
      take: RECENT_MESSAGES,
    });
    const newest = recent
      .flatMap((message) => storedMessageBlocks(message))
      .find((candidate) => candidate.kind === "mcp_approval" && candidate.serverId === server.id);
    // A connected card is an earlier outage the user already fixed; this is a new one.
    if (newest?.kind === "mcp_approval" && newest.status !== "connected") return null;
    const message = await createThreadMessageInTransaction(tx, {
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      role: "bot",
      blocks: [block],
      clientNonce: nonce,
    });
    return appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks: [block] },
    });
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (!committed) return false;
  await deps.events.notify(
    run.threadId,
    committed.seq,
    committed.firstResponse ? run.id : undefined,
  );
  return true;
}
