import type { ConnectorTool } from "@rakazo/adapter-kit";
import type { McpServer } from "@rakazo/db";
import { MAX_GROUP_LENGTH } from "../tools/lazy-tool-catalog.tool-definition.js";

/** Route name of the stand-in tool for an assigned server whose discovery failed. */
export const UNAVAILABLE_TOOL = "__rakazo_unavailable";

/** Source label in the lazy catalog. A generated slug can be an opaque id, so the server's name is what the model sees. */
export function mcpCatalogGroup(server: { name?: string | null; slug: string }): string {
  const name = server.name?.trim();
  return (name || server.slug).slice(0, MAX_GROUP_LENGTH);
}

/** Stand-in for an assigned server whose tools could not be listed, so the model can say
 * why instead of concluding the server is not assigned. Calling it returns the reason. */
export function unavailableTool(
  server: Pick<McpServer, "id" | "name" | "slug" | "revision">,
  reason: string,
): ConnectorTool {
  const brief = reason.length > 400 ? `${reason.slice(0, 400)}...` : reason;
  return {
    name: `mcp__${server.slug}__unavailable`,
    description: `The MCP server "${server.name}" is assigned to you but is unavailable right now, so none of its tools can be used. Reason: ${brief}. Tell the user it failed to start rather than saying it is not assigned. Calling this tool returns the same error.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    route: {
      connectorId: "mcp",
      resourceId: server.id,
      resourceRevision: server.revision,
      toolName: UNAVAILABLE_TOOL,
      catalogGroup: mcpCatalogGroup(server),
    },
  };
}
