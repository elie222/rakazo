import type { IntegrationCatalogResult, McpServer } from "@rakazo/contracts";
import { newClientId } from "./client-id.js";

export type SignInMcpServer = { name: string; endpoint: string };

/** Remote MCP servers a person can connect by signing in, without pasting a key first. */
export function signInMcpServers(results: readonly IntegrationCatalogResult[]): SignInMcpServer[] {
  const servers = new Map<string, SignInMcpServer>();
  for (const result of results) {
    for (const surface of result.surfaces) {
      if (surface.kind !== "mcp" || !surface.source?.startsWith("https://")) continue;
      if (surface.auth?.type === "bearer" || surface.auth?.type === "header") continue;
      if (!servers.has(surface.source))
        servers.set(surface.source, { name: result.name, endpoint: surface.source });
    }
  }
  return [...servers.values()];
}

/** The server already added for this endpoint, or a new one for it. */
export async function findOrAddMcpServer(
  server: SignInMcpServer,
  rpc: {
    list: () => Promise<McpServer[]>;
    create: (input: {
      slug: string;
      name: string;
      transport: "streamable_http";
      endpoint: string;
    }) => Promise<McpServer>;
  },
): Promise<McpServer> {
  const existing = (await rpc.list()).find((row) => row.endpoint === server.endpoint);
  return (
    existing ??
    rpc.create({
      slug: `integration-${newClientId().slice(0, 8)}`,
      name: server.name,
      transport: "streamable_http",
      endpoint: server.endpoint,
    })
  );
}
