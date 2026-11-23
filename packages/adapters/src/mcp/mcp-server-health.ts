import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { McpServerHealth } from "@rakazo/contracts";
import { MCP_OAUTH_CLIENT_REQUIRED } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

const HEALTH_MESSAGE_MAX = 2000;

/** What the MCP SDK throws when an authorization server offers no dynamic client
 * registration; only a client registered with it out of band can sign in. */
export const MCP_DYNAMIC_REGISTRATION_UNSUPPORTED =
  "Incompatible auth server: does not support dynamic client registration";

/** Whether connecting failed because the server needs a pre-registered OAuth client. */
export function needsMcpOAuthClient(error: unknown, depth = 0): boolean {
  if (depth > 5 || !(error instanceof Error)) return false;
  if (error.message.includes(MCP_DYNAMIC_REGISTRATION_UNSUPPORTED)) return true;
  return needsMcpOAuthClient(error.cause, depth + 1);
}

export type FailedOAuthRequest = { href: string; method: string; status: number };

/** Whether the authorization server turned away our client registration as not allowed
 * (401 or 403 at its registration endpoint): it accepts only clients registered with it
 * out of band, so the user must enter one. */
export function refusedRegistration(
  failed: FailedOAuthRequest | undefined,
  discovery: OAuthDiscoveryState | undefined,
): boolean {
  if (failed?.method !== "POST" || (failed.status !== 401 && failed.status !== 403)) return false;
  const endpoint = discovery?.authorizationServerMetadata?.registration_endpoint;
  return endpoint !== undefined && new URL(endpoint).href === failed.href;
}

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
  /** Only record it while the server still has this revision, so a result about old
   * settings never replaces one about the current settings. */
  revision?: number,
): Promise<void> {
  try {
    // updateMany so a server deleted mid-probe is a silent no-op. Only health columns are
    // written: `revision` stays put (a bump evicts live sessions). `updatedAt` is touched by
    // Prisma's @updatedAt, but nothing orders or version-checks on it (it is display-only).
    await prisma.mcpServer.updateMany({
      where: { id: serverId, ...(revision === undefined ? {} : { revision }) },
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
    code:
      status === "error" && row.healthMessage?.includes(MCP_DYNAMIC_REGISTRATION_UNSUPPORTED)
        ? MCP_OAUTH_CLIENT_REQUIRED
        : null,
    toolCount: row.healthToolCount ?? null,
    checkedAt: row.healthCheckedAt?.toISOString() ?? null,
  };
}
