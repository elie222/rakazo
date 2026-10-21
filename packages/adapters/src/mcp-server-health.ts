import type { McpServerHealth } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

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
  // TODO(agent-B): implement (updateMany by id, truncate message, swallow errors).
  void prisma;
  void serverId;
  void update;
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
    message: row.healthMessage,
    toolCount: row.healthToolCount,
    checkedAt: row.healthCheckedAt?.toISOString() ?? null,
  };
}
