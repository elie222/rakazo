import type {
  CapabilityInstall,
  IntegrationCatalogResult,
  IntegrationCatalogSurface,
  McpServer,
  McpSourcePreset,
} from "@rakazo/contracts";
import { McpRemoteEndpointSchema } from "@rakazo/contracts";

export type SignInMcpServer = { name: string; endpoint: string };

/** Remote MCP servers a person can connect by signing in, without pasting a key first. */
export function signInMcpServers(results: readonly IntegrationCatalogResult[]): SignInMcpServer[] {
  return catalogMcpServers(results, { signInOnly: true }).map(({ name, source }) => ({
    name,
    endpoint: source,
  }));
}

export type CatalogMcpServer = {
  name: string;
  source: string;
  auth: IntegrationCatalogSurface["auth"];
};

export function catalogMcpServers(
  results: readonly IntegrationCatalogResult[],
  { signInOnly = false } = {},
): CatalogMcpServer[] {
  const servers = new Map<string, CatalogMcpServer>();
  for (const { name, surfaces } of results) {
    for (const { kind, source, auth } of surfaces) {
      if (kind !== "mcp" || !source?.startsWith("https://")) continue;
      if (!McpRemoteEndpointSchema.safeParse(source).success || servers.has(source)) continue;
      if (signInOnly && (auth?.type === "bearer" || auth?.type === "header")) continue;
      if (auth?.type === "header" && !auth.headerName) continue;
      servers.set(source, { name, source, auth });
    }
  }
  return [...servers.values()];
}

export function featuredMcpPresets(presets: readonly McpSourcePreset[], query: string) {
  const term = query.trim().toLowerCase();
  return presets.filter((preset) => preset.featured && preset.name.toLowerCase().includes(term));
}

/** Addresses already added through either of the remote MCP connection flows. */
export function addedMcpEndpoints(
  sources: readonly Pick<CapabilityInstall, "kind" | "source">[],
  servers: readonly Pick<McpServer, "endpoint">[],
): Set<string> {
  return new Set([
    ...sources.filter(({ kind }) => kind === "mcp").map(({ source }) => source),
    ...servers.map(({ endpoint }) => endpoint).filter((endpoint) => endpoint !== null),
  ]);
}
