import type { ConnectionCatalogItem, PluginMarketplaceEntry } from "@rakazo/contracts";
import {
  browsablePlugins,
  buildFeaturedConnectorTiles,
  CONNECTION_CATALOG_PAGE_SIZE,
  filterConnectionCatalogItems,
  filterPluginBrands,
  filterPlugins,
  integrationCatalogsReady,
  matchesWordPrefixes,
  pluginBrands,
  pluginCategories,
} from "@rakazo/core";
import { pluginCategoryLabel } from "@rakazo/i18n/plugin-catalog";
import { useMemo, useState } from "react";
import type { PluginConnections } from "./use-plugin-connections";

const NO_PLUGINS: PluginMarketplaceEntry[] = [];
export const PLUGIN_PAGE_SIZE = 24;

export type CatalogBrowse = ReturnType<typeof useCatalogBrowse>;

/**
 * The browse page's search, category, and paging, and what they pick from the app catalog and
 * the plugin marketplace.
 */
export function useCatalogBrowse({
  catalog,
  catalogLoaded,
  loadError,
  pluginCatalog,
}: {
  catalog: ConnectionCatalogItem[];
  catalogLoaded: boolean;
  loadError: string | null;
  pluginCatalog: PluginConnections["pluginCatalog"];
}) {
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(CONNECTION_CATALOG_PAGE_SIZE);
  const [category, setCategory] = useState<string | null>(null);
  const [pluginCount, setPluginCount] = useState(PLUGIN_PAGE_SIZE);

  const featuredTiles = useMemo(() => buildFeaturedConnectorTiles(catalog), [catalog]);
  const showFeatured = !query.trim();

  const visible = useMemo(() => filterConnectionCatalogItems(catalog, query), [catalog, query]);
  // Apps whose name starts with the query come before plugins; mid-word matches trail them.
  const strongMatches = showFeatured
    ? []
    : visible.filter((item) => matchesWordPrefixes(item.name, query));
  const weakMatches = showFeatured
    ? visible
    : visible.filter((item) => !matchesWordPrefixes(item.name, query));
  const rendered = weakMatches.slice(0, visibleCount);

  const catalogEntries = pluginCatalog.data?.entries ?? NO_PLUGINS;
  // An empty managed catalog says nothing about plugins that are still loading or unavailable.
  const catalogsReady = integrationCatalogsReady({
    catalogLoaded,
    catalogFailed: !!loadError,
    pluginsLoaded: pluginCatalog.isSuccess,
    pluginsUnavailable: !!pluginCatalog.data?.unavailableRegistries.length,
  });
  const { plugins, pluginForApp } = useMemo(
    () => browsablePlugins(catalogEntries, catalog),
    [catalog, catalogEntries],
  );
  const mergedBrands = pluginBrands(catalog, pluginForApp);
  const categories: string[] = pluginCategories([
    ...plugins,
    ...mergedBrands.map(({ entry }) => entry),
  ]);
  const brandMatches = filterPluginBrands(mergedBrands, query, category, pluginCategoryLabel);
  const searching = query.trim().length > 0;
  const pluginMatches = filterPlugins(plugins, query, category, pluginCategoryLabel);

  return {
    query,
    setQuery,
    visibleCount,
    setVisibleCount,
    category,
    setCategory,
    pluginCount,
    setPluginCount,
    featuredTiles,
    showFeatured,
    visible,
    strongMatches,
    weakMatches,
    rendered,
    catalogEntries,
    catalogsReady,
    plugins,
    pluginForApp,
    categoryLabel: pluginCategoryLabel,
    categories,
    brandMatches,
    searching,
    pluginMatches,
  };
}
