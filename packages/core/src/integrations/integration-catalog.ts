import type {
  CapabilityInstall,
  IntegrationCatalogResult,
  IntegrationCatalogSurface,
  McpServer,
  McpSourcePreset,
} from "@rakazo/contracts";
import {
  CATALOG_SEARCH_QUERY_MAX_LENGTH,
  CATALOG_SEARCH_QUERY_MIN_LENGTH,
  McpRemoteEndpointSchema,
} from "@rakazo/contracts";

/** MCP services offered as one-step sources. A preset with a URL always connects there. */
export const MCP_SOURCE_PRESETS: McpSourcePreset[] = [
  {
    id: "github",
    name: "GitHub",
    url: "https://api.githubcopilot.com/mcp/readonly",
    featured: true,
    credentialHelpUrl: "https://github.com/settings/personal-access-tokens/new",
  },
  { id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", signIn: true, featured: true },
  { id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", signIn: true, featured: true },
  // A self-hosted Executor serves the same endpoint at its own origin, so the URL stays editable.
  { id: "executor", name: "Executor", defaultUrl: "https://mcp.executor.sh/mcp", signIn: true },
];

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
  {
    signInOnly = false,
    excludedNames = [],
  }: { signInOnly?: boolean; excludedNames?: readonly string[] } = {},
): CatalogMcpServer[] {
  const excluded = new Set(excludedNames.map((name) => name.toLowerCase()));
  const servers = new Map<string, CatalogMcpServer>();
  for (const { name, surfaces } of results) {
    if (excluded.has(name.toLowerCase())) continue;
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

export function publicMcpCatalogQuery(value: string, requestedQuery: string | null) {
  const query = value.trim();
  const eligible =
    query.length >= CATALOG_SEARCH_QUERY_MIN_LENGTH &&
    query.length <= CATALOG_SEARCH_QUERY_MAX_LENGTH;
  return {
    input: { query, usePublicCatalog: true },
    eligible,
    requested: eligible && requestedQuery === query,
  };
}
