import type {
  CapabilityInstall,
  ConnectionCatalogItem,
  McpServer,
  PluginMarketplaceEntry,
} from "@rakazo/contracts";
import { PluginPreviewSchema } from "@rakazo/contracts";
import type { PluginCategory } from "@rakazo/core";
import {
  catalogItemKey,
  installedPluginParts,
  managedAppFor,
  matchesPluginQuery,
  OTHER_PLUGINS,
  PLUGIN_CATEGORIES,
} from "@rakazo/core";

/** What the plugin screen needs, from a catalog entry or a pasted GitHub URL. */
export type PluginParams = {
  source: string;
  installedSource: string;
  name: string;
  description?: string;
  logo?: string;
  site?: string;
  managedConnectorId?: string;
  managedSlug?: string;
  /** "1" when opened from Skills: only the plugin's skills are added there. */
  skillsOnly?: string;
};

export function pluginParams(entry: PluginMarketplaceEntry): PluginParams {
  const site = pluginSite(entry);
  return {
    source: entry.source,
    installedSource: entry.installedSource,
    name: entry.displayName,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.logo ? { logo: entry.logo } : {}),
    ...(site ? { site } : {}),
  };
}

export function gitImportParams(url: string): PluginParams {
  const source = url.trim().replace(/\/$/, "");
  return { source, installedSource: source, name: source.split("/").pop() || source };
}

/** GitHub homepages would give every plugin the same mark, so they never stand in for a site. */
export function pluginSite(
  entry: Pick<PluginMarketplaceEntry, "homepage" | "domains">,
): string | null {
  const domain = entry.domains[0]?.replace(/^https?:\/\//, "").split("/")[0];
  if (domain) return `https://${domain}`;
  try {
    return entry.homepage && !new URL(entry.homepage).hostname.endsWith("github.com")
      ? new URL(entry.homepage).origin
      : null;
  } catch {
    return null;
  }
}

/**
 * One row per brand: a plugin for a managed app lends that app its skills instead of being
 * listed again, and skill packs with nothing to connect belong to Skills, not Integrations.
 */
export function browsablePlugins(
  entries: PluginMarketplaceEntry[],
  managed: ConnectionCatalogItem[],
): { plugins: PluginMarketplaceEntry[]; pluginForApp: Map<string, PluginMarketplaceEntry> } {
  const pluginForApp = new Map<string, PluginMarketplaceEntry>();
  const plugins: PluginMarketplaceEntry[] = [];
  for (const entry of entries) {
    const app = managedAppFor(entry, managed);
    if (app) {
      if (entry.skillCount && !pluginForApp.has(catalogItemKey(app)))
        pluginForApp.set(catalogItemKey(app), entry);
    } else if (entry.hasConnector) plugins.push(entry);
  }
  return { plugins, pluginForApp };
}

export function skillPacks(entries: PluginMarketplaceEntry[], query: string) {
  return entries.filter((entry) => !entry.hasConnector && matchesPluginQuery(entry, query));
}

/** The plugin screen connects this managed app instead of the plugin's own connector. */
export function managedPluginParams(
  entry: PluginMarketplaceEntry,
  app: ConnectionCatalogItem,
): PluginParams {
  return {
    ...pluginParams(entry),
    name: app.name,
    ...(app.logo ? { logo: app.logo } : {}),
    managedConnectorId: app.connectorId,
    managedSlug: app.slug,
  };
}

export function pluginCategories(entries: PluginMarketplaceEntry[]): PluginCategory[] {
  return PLUGIN_CATEGORIES.filter((name) => entries.some((entry) => entry.category === name));
}

export function filterPlugins(
  entries: PluginMarketplaceEntry[],
  query: string,
  category: string | null,
  categoryLabel: (name: string) => string,
): PluginMarketplaceEntry[] {
  return entries.filter(
    (entry) =>
      (!category || entry.category === (category === OTHER_PLUGINS ? null : category)) &&
      matchesPluginQuery(entry, query, entry.category ? categoryLabel(entry.category) : ""),
  );
}

/** Signed in, or answering without a sign-in. */
export function mcpServerReady(server: McpServer): boolean {
  return server.oauthStatus === "connected" || server.health.status === "ok";
}

/** Skills an install added; none when only its connector was added. */
export function pluginSkillCount(install: CapabilityInstall): number {
  if (!installedPluginParts(install.config).includes("skills")) return 0;
  const parsed = PluginPreviewSchema.safeParse(install.config);
  return parsed.success ? parsed.data.skills.length : 0;
}

export function hasPluginConnector(install: CapabilityInstall): boolean {
  return installedPluginParts(install.config).includes("connector");
}

export function sourceHref(source: string, sha: string | undefined): string {
  const [repo, subdir] = source.split("#");
  return subdir ? `${repo}/tree/${sha ?? "HEAD"}/${subdir}` : (repo ?? source);
}
