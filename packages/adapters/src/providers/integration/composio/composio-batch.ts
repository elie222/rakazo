import type { ConnectorTool, OutgoingDraftDescriptor, ToolBatch } from "@rakazo/adapter-kit";

export const COMPOSIO_MULTI_EXECUTE_TOOL = "COMPOSIO_MULTI_EXECUTE_TOOL";
const outgoingDrafts: Readonly<Record<string, OutgoingDraftDescriptor>> = {
  GMAIL_SEND_EMAIL: {
    kind: "email",
    source: "Gmail",
    keys: { to: "recipient_email", subject: "subject", body: "body" },
    defaults: { user_id: "me", is_html: false },
    recipientAlias: "to",
  },
  SLACK_SEND_MESSAGE: {
    kind: "message",
    source: "Slack",
    keys: { to: "channel", body: "text" },
  },
};

const COMPOSIO_BATCH: ToolBatch = {
  items: "tools",
  action: "tool_slug",
  arguments: "arguments",
};

export function composioOutgoingDraft(toolName: string): OutgoingDraftDescriptor | undefined {
  return Object.hasOwn(outgoingDrafts, toolName) ? outgoingDrafts[toolName] : undefined;
}

/**
 * Composio runs every action through one batch tool, naming each in `tools[].tool_slug`, whether
 * its tools come from a Composio session or a Composio MCP server.
 */
export function composioToolBatch(toolName: string): ToolBatch | undefined {
  return toolName === COMPOSIO_MULTI_EXECUTE_TOOL ? COMPOSIO_BATCH : undefined;
}

export function composioSessionToolBatch(toolName: string): ToolBatch | undefined {
  const batch = composioToolBatch(toolName);
  return batch && { ...batch, outgoingDrafts };
}

export function composioMcpToolFields(
  name: string,
  endpoint: string | null | undefined,
): Pick<ConnectorTool, "batch" | "outgoingDraft"> {
  const url = endpoint && URL.canParse(endpoint) ? new URL(endpoint) : undefined;
  const knownEndpoint =
    (url?.origin === "https://connect.composio.dev" && url.pathname === "/mcp") ||
    (url?.origin === "https://app.composio.dev" &&
      /^\/tool_router\/v3\/trs_[a-zA-Z0-9_-]+\/mcp$/.test(url.pathname));
  return knownEndpoint
    ? { batch: composioSessionToolBatch(name), outgoingDraft: composioOutgoingDraft(name) }
    : { batch: composioToolBatch(name) };
}
