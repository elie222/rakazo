import type {
  CapabilityInstall,
  ConnectionCatalogItem,
  PluginMarketplaceEntry,
} from "@rakazo/contracts";
import { PluginPreviewSchema } from "@rakazo/contracts";
import { installedPluginParts, matchesPluginQuery, pluginSite } from "@rakazo/core";

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

/** Skills an install added; none when only its connector was added. */
export function pluginSkillCount(install: CapabilityInstall): number {
  if (!installedPluginParts(install.config).includes("skills")) return 0;
  const parsed = PluginPreviewSchema.safeParse(install.config);
  return parsed.success ? parsed.data.skills.length : 0;
}

export function hasPluginConnector(install: CapabilityInstall): boolean {
  return installedPluginParts(install.config).includes("connector");
}

/**
 * Where a plugin's source can be read: its repository, or the pinned subfolder in it. Null when
 * the source is not a web address, such as a bare name, so there is nothing to open.
 */
export function sourceHref(source: string, sha: string | undefined): string | null {
  const [repo = "", subdir] = source.split("#");
  if (!/^https?:\/\//i.test(repo)) return null;
  return subdir ? `${repo}/tree/${sha ?? "HEAD"}/${subdir}` : repo;
}
