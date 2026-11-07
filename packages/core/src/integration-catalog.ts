import type { IntegrationCatalogResult } from "@rakazo/contracts";

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
