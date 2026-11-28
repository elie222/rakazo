/**
 * Appended to Antigravity ACP's system prompt so the model calls Rakazo's MCP-prefixed tools
 * rather than unprefixed CLI built-ins. Kept static per tool server for prompt-cache stability.
 */
export function antigravityToolRoutingRule(toolServer: string | undefined): string {
  return toolServer
    ? `\n\nTool routing: Every Rakazo tool referenced above is exposed with the \`mcp_${toolServer}_\` prefix. Call only \`mcp_${toolServer}_*\` tools; never call unprefixed CLI built-in tools.`
    : "\n\nTool routing: No tools are enabled for this turn. Never call CLI built-in tools; answer directly in text.";
}
