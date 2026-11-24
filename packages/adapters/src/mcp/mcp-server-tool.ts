import type { McpTransport, MessageBlock } from "@rakazo/contracts";
import { McpRemoteEndpointSchema, McpTransportSchema } from "@rakazo/contracts";
import { deriveMcpSlug } from "@rakazo/core";
import type { McpServer } from "@rakazo/db";
import {
  availableInSpace,
  isUniqueViolation,
  storedMessageBlocks,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { MarketplaceConnector } from "../integrations/marketplace-connectors.js";
import { toStringRecord } from "../memory/memory-provider-factory.js";
import { persistMessageInTransaction, runLeaseFor } from "../runs/assembly/run-messages.js";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";
import { removeMcpServerInTransaction } from "./mcp-server-removal.js";
import { assertNoMcpEndpointCredential, assertSafeRemoteUrl } from "./remote-mcp.js";

export { deriveMcpSlug } from "@rakazo/core";

const MAX_HEADERS = 32;
/** Only recent cards count as already shown; an old one far up the chat should not block a new one. */
const RECENT_MESSAGES = 50;

export type ParsedMcpServerArgs = {
  slug: string;
  name: string;
  description: string;
  transport: Exclude<McpTransport, "stdio">;
  endpoint: string;
  headers: Record<string, string>;
  secret?: string;
  assignToSelf: boolean;
};

/** Returns undefined for anything that would fail server-side validation,
 * so the model gets a single actionable error instead of a partial create. */
export function parseMcpServerToolArgs(
  args: Record<string, unknown>,
): ParsedMcpServerArgs | undefined {
  const name = typeof args.name === "string" ? args.name.trim().slice(0, 120) : "";
  if (!name) return undefined;
  const parsedTransport = McpTransportSchema.safeParse(args.transport);
  if (!parsedTransport.success || parsedTransport.data === "stdio") return undefined;
  const transport = parsedTransport.data;

  const endpoint = typeof args.endpoint === "string" ? args.endpoint.trim() : "";
  if (!McpRemoteEndpointSchema.safeParse(endpoint).success) return undefined;

  const headers = toStringRecord(args.headers);
  if (Object.keys(headers).length > MAX_HEADERS) return undefined;

  return {
    slug: deriveMcpSlug(name),
    name,
    description: typeof args.description === "string" ? args.description.slice(0, 2000) : "",
    transport,
    endpoint,
    headers,
    secret:
      typeof args.secret === "string" && args.secret ? args.secret.slice(0, 16384) : undefined,
    assignToSelf: args.assign_to_self !== false,
  };
}

/** Serialized credential blob for the encrypted secret store; null when the
 * server has no static credential material. */
export function buildMcpCredentialBlob(parsed: {
  secret?: string;
  /** Stdio launch arguments, which may carry tokens. */
  args?: string[];
  env?: Record<string, string>;
  files?: Record<string, string>;
  headers?: Record<string, string>;
  oauthClient?: {
    clientId: string;
    clientSecret?: string;
    scope?: string;
    authorizationServer?: string;
    authorizationParams?: string;
  } | null;
}): string | null {
  const env = parsed.env ?? {};
  const headers = parsed.headers ?? {};
  const files = parsed.files ?? {};
  const args = parsed.args ?? [];
  const client = parsed.oauthClient;
  if (
    !parsed.secret &&
    args.length === 0 &&
    !client &&
    Object.keys(env).length === 0 &&
    Object.keys(headers).length === 0 &&
    Object.keys(files).length === 0
  ) {
    return null;
  }
  return JSON.stringify({
    secret: parsed.secret,
    env,
    headers,
    ...(Object.keys(files).length > 0 ? { files } : {}),
    ...(args.length > 0 ? { args } : {}),
    ...(client
      ? {
          oauthClient: {
            client_id: client.clientId,
            ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
            ...(client.scope ? { scope: client.scope } : {}),
            ...(client.authorizationParams
              ? { authorization_params: client.authorizationParams }
              : {}),
            ...(client.authorizationServer
              ? { authorization_server: new URL(client.authorizationServer).href }
              : {}),
          },
        }
      : {}),
  });
}

/** Heuristic for whether the approval card should lead with OAuth: remote
 * servers without a static credential usually need browser authorization. */
export function needsOAuthProbe(parsed: {
  transport: string;
  secret?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}): boolean {
  if (parsed.transport === "stdio") return false;
  const env = parsed.env ?? {};
  const headers = parsed.headers ?? {};
  return !parsed.secret && Object.keys(env).length === 0 && Object.keys(headers).length === 0;
}

/** add_mcp_server: registers the server and, when asked, posts its approval card. */
export async function addMcpServerFromTool(
  deps: ExecutorDeps,
  run: ToolRun,
  botId: string,
  args: Record<string, unknown>,
  executionId: string,
) {
  // A local server runs on the deployment's own hosts, so only an admin adds one.
  if (args.transport === "stdio") {
    return {
      error: "Bots can't add local (stdio) MCP servers. Ask an admin to add it in Settings.",
    };
  }
  const parsed = parseMcpServerToolArgs(args);
  if (!parsed) {
    return {
      error:
        "Invalid MCP server details. Required: name, transport (streamable_http|sse), and an endpoint URL.",
    };
  }
  return registerMcpServer(deps, run, botId, parsed, executionId);
}

type ToolRun = { id: string; spaceId: string; userId: string; threadId: string; botId: string };

/** connect_app's fallback: offers a marketplace plugin's connector on the same approval card
 * add_mcp_server posts, reusing the server when the user already has it. */
export async function addMarketplaceConnector(
  deps: ExecutorDeps,
  run: ToolRun,
  botId: string,
  connector: MarketplaceConnector,
  executionId: string,
) {
  const listing = { description: connector.description, logo: connector.logo };
  // One card per call, even when a replay of it finds the server the first attempt saved.
  const nonce = `connect-app:${executionId}`;
  const matches = await deps.prisma.mcpServer.findMany({
    where: { endpoint: connector.server.endpoint, ...availableInSpace(run) },
    select: {
      id: true,
      name: true,
      enabled: true,
      allBots: true,
      headers: true,
      assignments: { where: { botId }, select: { id: true } },
    },
    orderBy: { enabled: "desc" },
  });
  if (matches.some((match) => match.enabled && (match.allBots || match.assignments.length > 0)))
    return {
      status: "connected",
      message: "This app is already connected and its tools are available.",
    };
  const existing = matches[0];
  if (!existing)
    return registerMcpServer(
      deps,
      run,
      botId,
      {
        slug: deriveMcpSlug(connector.name),
        name: connector.name,
        description: connector.description.slice(0, 2000),
        transport: connector.server.transport,
        endpoint: connector.server.endpoint,
        headers: {},
        assignToSelf: true,
      },
      executionId,
      listing,
      nonce,
    );
  if (!existing.enabled)
    return {
      error: `${existing.name} is turned off. Ask the user to turn it on in Settings.`,
    };
  // A server given credentials in its headers is approved as it is. Otherwise Authorize asks the
  // server, which signs in when it needs to and goes straight on when not; a stored secret is no
  // sign of a login, since starting one saves the client registration there.
  const signsIn = !hasKeys(existing.headers);
  const committed = await deps.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
    const shown = await tx.message.findFirst({
      where: { threadId: run.threadId, clientNonce: nonce },
      select: { id: true },
    });
    if (shown) return null;
    // Asking again while a card for this server still waits points at that card instead.
    const recent = await tx.message.findMany({
      where: { threadId: run.threadId },
      select: { id: true, blocks: true },
      orderBy: { createdAt: "desc" },
      take: RECENT_MESSAGES,
    });
    if (
      recent.some((message) =>
        storedMessageBlocks(message).some(
          (block) =>
            block.kind === "mcp_approval" &&
            block.serverId === existing.id &&
            block.status === "pending",
        ),
      )
    )
      return null;
    return persistMessageInTransaction(
      tx,
      run,
      "bot",
      [approvalCard(existing, connector.server.transport, signsIn, listing)],
      undefined,
      nonce,
      false,
      runLeaseFor(deps, run.id),
    );
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (committed) await notifyApproval(deps, run, committed.eventSeq, committed.firstResponseRunId);
  return { ok: true, server_id: existing.id, next_step: cardNextStep(signsIn) };
}

function hasKeys(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
}

function approvalCard(
  server: { id: string; name: string },
  transport: McpTransport,
  needsOAuth: boolean,
  listing?: { description: string; logo: string | null },
  endpoint: string | null = null,
): MessageBlock {
  return {
    kind: "mcp_approval",
    name: server.name,
    serverId: server.id,
    transport,
    // A listing says what the server is; the address is only shown for one the bot was given.
    endpoint: listing ? null : endpoint,
    needsOAuth,
    status: "pending",
    ...listing,
  };
}

async function notifyApproval(
  deps: ExecutorDeps,
  run: ToolRun,
  eventSeq: number | undefined,
  firstResponseRunId: string | undefined,
) {
  if (eventSeq === undefined) return;
  await deps.events.notify(run.threadId, eventSeq, firstResponseRunId).catch((error) => {
    getLogger().error("MCP approval realtime notification", error);
  });
}

function cardNextStep(oauthLikely: boolean) {
  return `An approval card is in the chat. End your turn with one short sentence asking the user to ${oauthLikely ? "authorize" : "approve"} it there; the card already shows the server's details. You will be told when they connect it.`;
}

async function registerMcpServer(
  deps: ExecutorDeps,
  run: ToolRun,
  botId: string,
  parsed: ParsedMcpServerArgs,
  executionId: string,
  listing?: { description: string; logo: string | null },
  clientNonce?: string,
) {
  try {
    await assertSafeRemoteUrl(parsed.endpoint, deps.secretHttp?.resolveHostname, {
      allowPrivateEndpoint: deps.mcpAllowPrivateEndpoint === true,
    });
    assertNoMcpEndpointCredential(parsed.endpoint);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Invalid MCP endpoint",
    };
  }
  if (!deps.secretStore) {
    return {
      error: "Secret storage is not available in this deployment.",
    };
  }
  const credentialBlob = buildMcpCredentialBlob(parsed);
  let storedCredential: { id: string; ciphertext: string } | null = null;
  if (credentialBlob) {
    storedCredential = await deps.secretStore.put(credentialBlob, {
      operationId: executionId,
      traceId: executionId,
      spaceId: run.spaceId,
      userId: run.userId,
      botId,
      signal: new AbortController().signal,
    });
  }
  const oauthLikely = needsOAuthProbe(parsed);
  let serverRow: McpServer;
  let approvalEventSeq: number | undefined;
  let approvalResponseRunId: string | undefined;
  try {
    const created = await deps.prisma.$transaction(async (tx) => {
      if (storedCredential) {
        await tx.secret.create({
          data: {
            id: storedCredential.id,
            userId: run.userId,
            spaceId: run.spaceId,
            kind: "mcp",
            ciphertext: storedCredential.ciphertext,
          },
        });
      }
      const server = await tx.mcpServer.create({
        data: {
          spaceId: run.spaceId,
          userId: run.userId,
          slug: parsed.slug,
          name: parsed.name,
          description: parsed.description,
          transport: parsed.transport,
          endpoint: parsed.endpoint,
          headers: Object.fromEntries(Object.keys(parsed.headers).map((key) => [key, true])),
          secretId: storedCredential?.id,
          enabled: true,
        },
      });
      if (!parsed.assignToSelf) return { server };
      const blocks = [
        approvalCard(server, parsed.transport, oauthLikely, listing, parsed.endpoint),
      ];
      const committed = await persistMessageInTransaction(
        tx,
        run,
        "bot",
        blocks,
        undefined,
        clientNonce,
        false,
        runLeaseFor(deps, run.id),
      );
      return {
        server,
        eventSeq: committed.eventSeq,
        firstResponseRunId: committed.firstResponseRunId,
      };
    });
    serverRow = created.server;
    approvalEventSeq = created.eventSeq;
    approvalResponseRunId = created.firstResponseRunId;
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        error: `An MCP server named "${parsed.name}" already exists. Ask the user to remove it first or pick another name.`,
      };
    }
    throw error;
  }
  await notifyApproval(deps, run, approvalEventSeq, approvalResponseRunId);
  return {
    ok: true,
    server_id: serverRow.id,
    next_step: parsed.assignToSelf
      ? cardNextStep(oauthLikely)
      : "The server was registered without assigning it to this bot.",
  };
}

/** remove_mcp_server: removes one of the run owner's remote servers available in the run's space. */
export async function removeMcpServerFromTool(
  deps: Pick<ExecutorDeps, "prisma" | "events">,
  run: { spaceId: string; userId: string },
  args: Record<string, unknown>,
) {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return { error: "Give the name of the MCP server to remove." };
  const servers = await deps.prisma.mcpServer.findMany({
    where: availableInSpace(run),
    select: { id: true, name: true, slug: true, transport: true, secretId: true },
  });
  const named = servers.filter((server) => server.name.toLowerCase() === name.toLowerCase());
  const slug = deriveMcpSlug(name);
  const matches = named.length > 0 ? named : servers.filter((server) => server.slug === slug);
  const remote = servers.filter((server) => server.transport !== "stdio");
  if (matches.length === 0) {
    return {
      error: `No MCP server named "${name}". Remote servers here: ${
        remote.map((server) => server.name).join(", ") || "none"
      }.`,
    };
  }
  if (matches.length > 1) {
    return {
      error: `More than one MCP server matches "${name}"; ask the user to remove it in Settings.`,
    };
  }
  const [server] = matches as [(typeof matches)[number]];
  if (server.transport === "stdio") {
    return { error: "Local (stdio) MCP servers are removed in Settings." };
  }
  const seqs = await deps.prisma.$transaction((tx) =>
    removeMcpServerInTransaction(tx, run, server),
  );
  for (const event of seqs) {
    await deps.events.notify(event.threadId, event.seq);
  }
  return { ok: true, removed: server.name };
}
