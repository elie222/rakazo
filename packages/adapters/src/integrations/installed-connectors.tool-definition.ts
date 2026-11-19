import type { ConnectorTool } from "@rakazo/adapter-kit";
import { UNAVAILABLE_TOOL } from "../mcp/mcp-connector.tool-definition.js";

/** Stand-in for an installed source whose tools could not be listed, so the model can say
 * why instead of concluding the source is not installed. */
export function unavailableInstalledTool(
  install: { id: string; kind: string; name: string },
  catalogGroup: string,
  reason: string,
): ConnectorTool {
  const brief = reason.length > 400 ? `${reason.slice(0, 400)}...` : reason;
  // Short enough that the name still fits a 64-character tool name once two installs with
  // the same name are told apart by an install id prefix.
  const slug =
    install.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+/, "")
      .slice(0, 13)
      .replace(/_+$/, "") || install.kind;
  return {
    name: `${slug}__unavailable`,
    description: `The installed source "${catalogGroup}" is available to you but could not be reached right now, so none of its tools can be used on this turn. Reason: ${brief}. Tell the user it is temporarily unavailable rather than saying it is not installed. Calling this tool only returns an error.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    route: {
      connectorId: "installed",
      resourceId: install.id,
      toolName: UNAVAILABLE_TOOL,
      catalogGroup,
    },
  };
}
