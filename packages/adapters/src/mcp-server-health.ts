import type { McpServerHealth } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

const HEALTH_MESSAGE_MAX = 2000;

/** A health observation to persist on an MCP server row. `checkedAt` defaults to now. */
export type McpServerHealthUpdate = {
  status: McpServerHealth["status"];
  message?: string | null;
  toolCount?: number | null;
};

/**
 * Persist the last launch/discovery outcome of an MCP server so the settings UI can show it.
 * Never throws: a health write must not turn a working tool call into a failure.
 */
export async function recordMcpServerHealth(
  prisma: PrismaClient,
  serverId: string,
  update: McpServerHealthUpdate,
): Promise<void> {
  try {
    // updateMany so a server deleted mid-probe is a silent no-op. Only health columns are
    // written: `revision` stays put (a bump evicts live sessions). `updatedAt` is touched by
    // Prisma's @updatedAt, but nothing orders or version-checks on it (it is display-only).
    await prisma.mcpServer.updateMany({
      where: { id: serverId },
      data: {
        healthStatus: update.status,
        healthMessage:
          update.status === "ok" || !update.message
            ? null
            : update.message.slice(0, HEALTH_MESSAGE_MAX),
        healthToolCount: update.toolCount ?? null,
        healthCheckedAt: new Date(),
      },
    });
  } catch (error) {
    getLogger().error("mcp server health write failed", error, { "mcp.server.id": serverId });
  }
}

/** Map persisted health columns onto the API DTO. */
export function mcpServerHealthDto(row: {
  healthStatus: string;
  healthMessage: string | null;
  healthToolCount: number | null;
  healthCheckedAt: Date | null;
}): McpServerHealth {
  const status = (["unknown", "installing", "ok", "error"] as const).find(
    (value) => value === row.healthStatus,
  );
  return {
    status: status ?? "unknown",
    message: row.healthMessage ?? null,
    toolCount: row.healthToolCount ?? null,
    checkedAt: row.healthCheckedAt?.toISOString() ?? null,
  };
}
