import type { AgentRunRequest } from "@rakazo/adapter-kit";

/** Servers whose tool results must stay whole. Ids cover catalog calls; slugs cover direct names. */
export type VerbatimMcpServers = NonNullable<AgentRunRequest["verbatimMcpServers"]>;

const DIRECT_MCP_TOOL = /^mcp__(.+?)__(.+)$/;
const CATALOG_EXECUTE = "connectors_execute_tool";

export function verbatimMcpServerSet(
  servers: readonly { id: string; slug: string; verbatimResults?: boolean }[],
): VerbatimMcpServers | undefined {
  const chosen = servers.filter((server) => server.verbatimResults);
  if (chosen.length === 0) return undefined;
  return {
    ids: chosen.map((server) => server.id),
    slugs: chosen.map((server) => server.slug),
  };
}

/** A tool call as stored on an assistant message, or the name recorded on its result. */
export function toolCallIdentity(
  call: unknown,
  fallbackName?: string,
): { name?: string; arguments?: unknown } {
  if (!call || typeof call !== "object") return { name: fallbackName };
  const record = call as { name?: unknown; arguments?: unknown };
  return {
    name: typeof record.name === "string" ? record.name : fallbackName,
    arguments: record.arguments,
  };
}

/**
 * True when this call belongs to a server that asked to keep results whole.
 * Catalog calls hide the server behind `connectors_execute_tool`; their id starts with the server id.
 */
export function isVerbatimMcpResult(
  name: string | undefined,
  args: unknown,
  servers: VerbatimMcpServers | undefined,
): boolean {
  if (!servers || !name) return false;
  const direct = DIRECT_MCP_TOOL.exec(name);
  if (direct) return servers.slugs.includes(direct[1]!);
  if (name !== CATALOG_EXECUTE) return false;
  const id =
    args && typeof args === "object" && "id" in args && typeof args.id === "string" ? args.id : "";
  const serverId = id.slice(0, id.indexOf(":"));
  return serverId.length > 0 && servers.ids.includes(serverId);
}
