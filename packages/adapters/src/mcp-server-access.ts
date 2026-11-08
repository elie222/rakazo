import type { McpTransport, MessageBlock } from "@rakazo/contracts";
import { mcpServerNeedsSignIn } from "@rakazo/contracts";
import { isOpenMcpApproval, MCP_APPROVAL_CARD_WINDOW } from "@rakazo/core";
import { availableInSpace } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { McpOAuthBroker } from "./mcp-oauth.js";
import { mcpServerHealthDto } from "./mcp-server-health.js";
import { persistMessageInTransaction, runLeaseFor } from "./run-messages.js";

type AccessDeps = Pick<ExecutorDeps, "prisma" | "events" | "runLease" | "secretStore">;
type AccessRun = { id: string; spaceId: string; userId: string; threadId: string; botId: string };

/**
 * This bot's approval cards in the thread's newest messages, in the window an approval repaints.
 * `declined` holds servers whose newest card was dismissed with no user message since.
 */
async function scanCards(deps: AccessDeps, run: AccessRun, botId: string) {
  const messages = await deps.prisma.message.findMany({
    where: { threadId: run.threadId },
    select: { botId: true, role: true, blocks: true },
    orderBy: { createdAt: "desc" },
    take: MCP_APPROVAL_CARD_WINDOW,
  });
  const open = new Set<string>();
  const declined = new Set<string>();
  const seen = new Set<string>();
  let userSince = false;
  for (const message of messages) {
    if (message.role === "user") {
      userSince = true;
      continue;
    }
    if (message.botId && message.botId !== botId) continue;
    for (const block of message.blocks as MessageBlock[]) {
      if (block.kind !== "mcp_approval") continue;
      if (isOpenMcpApproval(block)) open.add(block.serverId);
      if (seen.has(block.serverId)) continue;
      seen.add(block.serverId);
      if (block.status === "dismissed" && !userSince) declined.add(block.serverId);
    }
  }
  return { open, declined };
}

/** list_mcp_servers: the run member's enabled servers here, without endpoints or credentials. */
export async function listMcpServersForBot(deps: AccessDeps, run: AccessRun, botId: string) {
  const [servers, assignments, cards] = await Promise.all([
    deps.prisma.mcpServer.findMany({
      where: { enabled: true, ...availableInSpace(run) },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        transport: true,
        allBots: true,
        healthStatus: true,
        healthToolCount: true,
        healthCheckedAt: true,
      },
      orderBy: { name: "asc" },
    }),
    deps.prisma.botMcpServer.findMany({
      where: { botId, spaceId: run.spaceId, userId: run.userId },
      select: { serverId: true, allowAllTools: true, allowedTools: true },
    }),
    scanCards(deps, run, botId),
  ]);
  const assigned = new Map(assignments.map((row) => [row.serverId, row]));
  return {
    servers: servers.map((server) => {
      // The message can carry the server's own error text, so it is never listed.
      const health = mcpServerHealthDto({ ...server, healthMessage: null });
      // An assignment wins over sharing with every bot; a narrowed one offers only its tools.
      const assignment = assigned.get(server.id);
      const toolCount =
        assignment && !assignment.allowAllTools
          ? (assignment.allowedTools as unknown[]).length
          : health.toolCount;
      return {
        server_id: server.id,
        slug: server.slug,
        name: server.name,
        description: server.description,
        transport: server.transport,
        status:
          server.allBots || assignment
            ? "available"
            : cards.open.has(server.id)
              ? "pending"
              : "requestable",
        health: health.status,
        tool_count: toolCount,
        checked_at: health.checkedAt,
      };
    }),
  };
}

/** request_mcp_server: asks the owner, through the usual approval card, to give this bot a server. */
export async function requestMcpServerFromTool(
  deps: AccessDeps,
  run: AccessRun,
  botId: string,
  args: Record<string, unknown>,
) {
  const serverId = typeof args.server_id === "string" ? args.server_id.trim() : "";
  const slug = typeof args.slug === "string" ? args.slug.trim() : "";
  if (!serverId && !slug) {
    return { error: "Provide a server_id or slug from list_mcp_servers." };
  }
  // A slug is unique per Space, but servers shared from the member's other Spaces can repeat it.
  const matches = await deps.prisma.mcpServer.findMany({
    where: { ...availableInSpace(run), ...(serverId ? { id: serverId } : { slug }) },
    select: {
      id: true,
      name: true,
      transport: true,
      endpoint: true,
      secretId: true,
      enabled: true,
      allBots: true,
      healthStatus: true,
      healthMessage: true,
      healthToolCount: true,
      healthCheckedAt: true,
    },
  });
  const enabled = matches.filter((match) => match.enabled);
  if (enabled.length > 1) {
    return { error: "More than one MCP server has that slug. Pass its server_id instead." };
  }
  const server = enabled[0] ?? matches[0];
  if (!server) {
    return { error: "No MCP server matches that. Call list_mcp_servers to see the servers." };
  }
  if (!server.enabled) {
    return { error: "That MCP server is turned off. Ask the user to turn it on in Settings." };
  }
  const assignment = server.allBots
    ? null
    : await deps.prisma.botMcpServer.findFirst({
        where: { botId, spaceId: run.spaceId, userId: run.userId, serverId: server.id },
        select: { id: true },
      });
  if (server.allBots || assignment) {
    return { ok: true, server_id: server.id, status: "available" };
  }
  const cards = await scanCards(deps, run, botId);
  if (cards.declined.has(server.id)) {
    return {
      ok: true,
      server_id: server.id,
      status: "declined",
      next_step:
        "The user declined this server's approval card. Do not ask for it again unless the user brings it up.",
    };
  }
  if (cards.open.has(server.id)) {
    return {
      ok: true,
      server_id: server.id,
      status: "pending",
      next_step:
        "An approval card for this server is already in the chat. End your turn with one short sentence asking the user to answer it there. You will be told when they connect it.",
    };
  }
  // The settings screen's rule for offering Sign in, from the same stored OAuth state and health.
  const oauth = await new McpOAuthBroker(deps.prisma, deps.secretStore).summaryFor(server, run);
  const needsOAuth =
    server.transport !== "stdio" &&
    mcpServerNeedsSignIn({
      enabled: server.enabled,
      health: mcpServerHealthDto(server),
      oauthClientId: oauth.clientId,
      oauthStatus: oauth.status,
    });
  const blocks: MessageBlock[] = [
    {
      kind: "mcp_approval",
      name: server.name,
      serverId: server.id,
      transport: server.transport as McpTransport,
      endpoint: server.endpoint,
      needsOAuth,
      status: "pending",
    },
  ];
  const committed = await deps.prisma.$transaction((tx) =>
    persistMessageInTransaction(
      tx,
      run,
      "bot",
      blocks,
      undefined,
      undefined,
      false,
      runLeaseFor(deps, run.id),
    ),
  );
  await deps.events
    .notify(run.threadId, committed.eventSeq, committed.firstResponseRunId)
    .catch((error) => {
      getLogger().error("MCP approval realtime notification", error);
    });
  return {
    ok: true,
    server_id: server.id,
    status: "pending",
    next_step: `An approval card is in the chat. End your turn with one short sentence asking the user to ${needsOAuth ? "authorize" : "approve"} it there; the card already shows the server's details. You will be told when they connect it.`,
  };
}
