import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ConnectorTool } from "@rakazo/adapter-kit";
import { composioMcpToolFields } from "../providers/integration/composio/composio-batch.js";
import { executorApprovalFields } from "../providers/integration/executor/executor-approval.js";

type ApprovalLookup = {
  peer: string | undefined;
  connection: { id: string; name: string };
  lookup: (
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<{ result: unknown; binding: object } | undefined>;
};

/** Combine protocol hints with metadata contributed by the integration adapters. */
export function mcpToolFields(
  tool: Tool,
  endpoint?: string | null,
  approval?: ApprovalLookup,
): Pick<ConnectorTool, "inputSchema" | "readOnly" | "batch" | "outgoingDraft"> {
  return {
    inputSchema: tool.inputSchema,
    readOnly: tool.annotations?.readOnlyHint,
    ...composioMcpToolFields(tool.name, endpoint),
    ...(approval &&
      executorApprovalFields(approval.peer, tool, approval.connection, approval.lookup)),
  };
}
