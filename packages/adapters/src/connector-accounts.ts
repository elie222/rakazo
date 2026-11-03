import { createHash } from "node:crypto";
import type { ConnectedConnector, ConnectorTool } from "@rakazo/adapter-kit";

/** Each account gets stable tool names and an opaque local route, even when siblings change. */
export function scopeConnectorTools(
  tools: ConnectorTool[],
  connection: ConnectedConnector,
): ConnectorTool[] {
  return tools.map((tool) => {
    const suffix = createHash("sha256")
      .update(JSON.stringify([connection.id, tool.name]))
      .digest("hex")
      .slice(0, 16);
    return {
      ...tool,
      name: `${tool.name.slice(0, 46)}__${suffix}`,
      description: `${tool.description}\nConnected account: ${JSON.stringify(connection.displayName)} (${connection.id})`,
      route: {
        ...tool.route,
        connectorId: connection.connectorId,
        resourceId: tool.route?.resourceId ?? connection.externalId,
        toolName: tool.route?.toolName ?? tool.name,
        connectionId: connection.id,
        catalogGroup: `${connection.externalId} (${connection.displayName}; ${connection.id})`,
      },
    };
  });
}
