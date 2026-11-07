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

/** The enabled server already added for this endpoint, or a new one for it. A disabled one can't
 * sign in, so it is left as it is. */
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
  // Compare parsed URLs: the catalog's "https://host/" is a saved "https://host".
  const endpoint = new URL(server.endpoint).href;
  const existing = (await rpc.list()).find(
    (row) => row.enabled && row.endpoint && new URL(row.endpoint).href === endpoint,
  );
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
