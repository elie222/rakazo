import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { McpServer, PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { currentMcpAssignment, mcpToolAllowed } from "./mcp-tool-permissions.js";

export type McpToolOutcome =
  | { result: CallToolResult; binding: object; secrets: string[] }
  | { error: string };

export class McpApprovalConnectionChanged extends Error {
  constructor() {
    super("MCP connection changed before the call could run");
  }
}

/** Metadata for an authorized wrapper. Its result cannot reach the bot or ask for input. */
export async function lookupMcpApprovalActions(
  prisma: PrismaClient,
  expected: Pick<McpServer, "id" | "revision">,
  wrapper: string,
  context: AdapterContext,
  invoke: (server: McpServer) => Promise<McpToolOutcome>,
) {
  const assignment = await currentMcpAssignment(prisma, expected.id, context);
  if (
    !assignment ||
    assignment.server.revision !== expected.revision ||
    !mcpToolAllowed(assignment, wrapper)
  )
    return undefined;

  const outcome = await invoke(assignment.server);
  if ("error" in outcome || outcome.result.isError) {
    if (!context.signal.aborted)
      getLogger().warn("mcp.approval_actions.lookup_failed", {
        reason: "error" in outcome ? outcome.error : "MCP server reported an error",
      });
    return undefined;
  }
  return { result: outcome.result, binding: outcome.binding };
}
