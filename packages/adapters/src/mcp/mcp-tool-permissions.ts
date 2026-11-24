import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { availableInSpace } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** The same assignment policy applies to ordinary MCP calls and protocol bridges. */
export function mcpToolAllowed(
  assignment: { allowAllTools: boolean; allowedTools: unknown },
  tool: string,
): boolean {
  return (
    assignment.allowAllTools ||
    (Array.isArray(assignment.allowedTools) && assignment.allowedTools.includes(tool))
  );
}

/** A server every agent may use acts as an assignment that allows all its tools. */
export function sharedMcpAssignment<Server extends { id: string }>(server: Server) {
  return { serverId: server.id, allowAllTools: true, allowedTools: [] as unknown, server };
}

export async function currentMcpAssignment(
  prisma: Pick<PrismaClient, "botMcpServer" | "mcpServer">,
  serverId: string,
  context: AdapterContext,
) {
  if (!context.botId) return null;
  const usable = { enabled: true, ...availableInSpace(context) };
  return (
    (await prisma.botMcpServer.findFirst({
      where: {
        botId: context.botId,
        serverId,
        spaceId: context.spaceId,
        userId: context.userId,
        server: usable,
      },
      include: { server: true },
    })) ??
    (await prisma.mcpServer
      .findFirst({ where: { ...usable, id: serverId, allBots: true } })
      .then((server) => (server ? sharedMcpAssignment(server) : null)))
  );
}

/**
 * Stale allowlist entries are filtered out below with no error. Discovery already has the
 * live tool list, so compare once and warn when string allowlist names are missing from the
 * server. Non-string JSON values are ignored for both the missing list and the ratio.
 */
export function allowlistDrift(
  allowedTools: unknown,
  offered: Array<{ name: string }>,
): { missing: string[]; offered: number; stringAllowedCount: number } {
  const names = new Set(offered.map((tool) => tool.name));
  const allowed = Array.isArray(allowedTools) ? allowedTools : [];
  const stringAllowed = allowed.filter((name): name is string => typeof name === "string");
  return {
    missing: stringAllowed.filter((name) => !names.has(name)),
    offered: names.size,
    stringAllowedCount: stringAllowed.length,
  };
}

export function reportAllowlistDrift(
  assignment: { allowAllTools: boolean; allowedTools: unknown; server: { slug: string } },
  offered: Array<{ name: string }>,
  context: { spaceId: string; botId?: string },
): void {
  if (assignment.allowAllTools) return;
  const drift = allowlistDrift(assignment.allowedTools, offered);
  if (drift.missing.length === 0) return;
  getLogger().warn(
    `mcp allowlist drift on ${assignment.server.slug}: ${drift.missing.length}/${drift.stringAllowedCount} allowed tools are not offered (server offers ${drift.offered})`,
    {
      spaceId: context.spaceId,
      botId: context.botId,
      // Cap the list: the point is to name the drift, not to print an allowlist.
      missing: drift.missing.slice(0, 10),
    },
  );
}
