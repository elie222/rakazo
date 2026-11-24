import { Trans, useLingui } from "@lingui/react/macro";
import type {
  ConnectionCatalogItem,
  McpSourcePreset,
  PluginMarketplaceEntry,
} from "@rakazo/contracts";
import { SUBMIT_PLUGIN_URL } from "@rakazo/contracts";
import type { CatalogMcpServer } from "@rakazo/core";
import {
  addedMcpEndpoints,
  CONNECTION_CATALOG_PAGE_SIZE,
  catalogItemKey,
  catalogMcpServers,
  featuredMcpPresets,
  isRecommendedPlugin,
  managedAppFor,
  OTHER_PLUGINS,
  publicMcpCatalogQuery,
} from "@rakazo/core";
import { Button, SectionHeading, Spinner } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import type { PluginSelection } from "../../components/integrations/plugin-marketplace";
import { PluginRow, pluginSelection } from "../../components/integrations/plugin-marketplace";
import { useSpaceQueries } from "../../lib/query/query";
import type { TileContext } from "./parts";
import { CatalogTile } from "./parts";
import type { CatalogBrowse } from "./use-catalog-browse";
import { PLUGIN_PAGE_SIZE } from "./use-catalog-browse";
import type { PluginConnections } from "./use-plugin-connections";

const SECTION_SIZE = 6;

/** The browse page under the search: featured apps, plugin sections or matches, and more apps. */
export function PluginBrowse({
  browse,
  state,
  tileContext,
  onOpenPlugin,
  publicTerm,
  onSearchPublic,
  onOpenPreset,
  onOpenMcp,
}: {
  browse: CatalogBrowse;
  state: PluginConnections;
  tileContext: TileContext;
  onOpenPlugin: (selection: PluginSelection) => void;
  publicTerm: string;
  onSearchPublic: (term: string) => void;
  onOpenPreset: (preset: McpSourcePreset) => void;
  onOpenMcp: (server: CatalogMcpServer) => void;
}) {
  const { t } = useLingui();
  const { catalogLoaded, catalog, pluginCatalog, pluginInstalls, sourcePresets } = state;
  const {
    query,
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
    categoryLabel,
    categories,
    brandMatches,
    searching,
    pluginMatches,
  } = browse;
  const search = publicMcpCatalogQuery(query, publicTerm);
  const term = search.input.query;
  const directReady = !state.loading && !state.mcpQuery.isPending;
  const browsePublic = directReady && !category && search.eligible;
  const searchingPublic = browsePublic && search.requested;
  const queries = useSpaceQueries();
  const publicCatalog = useQuery({
    ...queries.capabilities.catalogSearch.queryOptions({ input: search.input }),
    enabled: searchingPublic,
    staleTime: 60_000,
    retry: false,
  });
  const managedNames = new Set(catalog.map(({ name }) => name.toLowerCase()));
  const presets =
    category || !directReady
      ? []
      : featuredMcpPresets(sourcePresets, term).filter(
          ({ name }) => !managedNames.has(name.toLowerCase()),
        );
  const remoteMatches =
    searchingPublic && publicCatalog.data
      ? catalogMcpServers(publicCatalog.data.results, {
          excludedNames: [...managedNames, ...presets.map(({ name }) => name)],
        })
      : [];
  const addedEndpoints = addedMcpEndpoints(state.sources, state.mcpServers);
  const waitingForPublic = searchingPublic && publicCatalog.isFetching;

  const installedPlugin = (installedSource: string) =>
    pluginInstalls.find((row) => row.source === installedSource);

  function catalogTile(
    item: ConnectionCatalogItem,
    label: string,
    logo?: string | null,
    opts?: { tileTestId?: boolean },
  ) {
    return (
      <CatalogTile
        key={catalogItemKey(item)}
        item={item}
        label={label}
        logo={logo}
        tileTestId={opts?.tileTestId}
        context={tileContext}
      />
    );
  }

  function renderPluginRow(entry: PluginMarketplaceEntry) {
    const selection = pluginSelection(entry);
    return (
      <PluginRow
        key={entry.id}
        name={entry.displayName}
        description={entry.description}
        logo={entry.logo}
        site={selection.site}
        installed={Boolean(installedPlugin(entry.installedSource))}
        onOpen={() => onOpenPlugin(selection)}
      />
    );
  }

  function renderPluginSections() {
    if (pluginCatalog.isPending)
      return (
        <div className="grid place-items-center py-8">
          <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading plugins…`} />
        </div>
      );
    const unavailable =
      pluginCatalog.error || pluginCatalog.data?.unavailableRegistries.length ? (
        <div role="alert" className="mt-6 flex items-center gap-3 text-body text-muted-foreground">
          <Trans>Some plugins could not be loaded.</Trans>
          <Button variant="outline" size="sm" onClick={() => void pluginCatalog.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null;
    return (
      <>
        {unavailable}
        {renderPluginResults()}
      </>
    );
  }

  function renderPluginResults() {
    if (category || searching)
      return pluginMatches.length || brandMatches.length ? (
        <section data-testid="plugin-results" className="mt-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {brandMatches.map(({ item }) => catalogTile(item, item.name, item.logo))}
            {pluginMatches.slice(0, pluginCount).map(renderPluginRow)}
          </div>
          {pluginCount < pluginMatches.length ? (
            <div className="mt-4 flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPluginCount((count) => count + PLUGIN_PAGE_SIZE)}
              >
                <Trans>Show more</Trans>
              </Button>
            </div>
          ) : null}
        </section>
      ) : null;
    // A recommended brand this deployment already offers as a managed app is listed as that app.
    const recommended = catalogEntries
      .filter(isRecommendedPlugin)
      .map((entry) => ({ entry, item: managedAppFor(entry, catalog) }))
      .filter(({ entry, item }) => item || entry.hasConnector)
      .slice(0, SECTION_SIZE);
    const uncategorized = plugins.filter((entry) => !entry.category);
    const sections: Array<[string, string, PluginMarketplaceEntry[]]> = [
      ...categories.map((name): [string, string, PluginMarketplaceEntry[]] => [
        name,
        categoryLabel(name),
        plugins.filter((entry) => entry.category === name),
      ]),
      ...(uncategorized.length
        ? [[OTHER_PLUGINS, t`More`, uncategorized] as [string, string, PluginMarketplaceEntry[]]]
        : []),
    ].filter(([, , entries]) => entries.length);
    return (
      <>
        {recommended.length ? (
          <section data-testid="plugin-section" className="mt-8">
            <SectionHeading as="h2" className="mb-2 px-2.5">
              <Trans>Recommended</Trans>
            </SectionHeading>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {recommended.map(({ entry, item }) =>
                item ? catalogTile(item, item.name, item.logo) : renderPluginRow(entry),
              )}
            </div>
          </section>
        ) : null}
        {sections.map(([name, label, entries]) => (
          <section key={name} data-testid="plugin-section" className="mt-8">
            <div className="mb-2 flex items-center justify-between px-2.5">
              <SectionHeading as="h2">{label}</SectionHeading>
              {entries.length > SECTION_SIZE ? (
                <Button variant="text" size="sm" onClick={() => setCategory(name)}>
                  <Trans>View all</Trans>
                </Button>
              ) : null}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {entries.slice(0, SECTION_SIZE).map(renderPluginRow)}
            </div>
          </section>
        ))}
      </>
    );
  }

  return (
    <>
      {presets.length ? (
        <div className="my-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {presets.map((preset) => (
            <PluginRow
              key={preset.id}
              name={preset.name}
              description=""
              installed={Boolean(preset.url && addedEndpoints.has(preset.url))}
              onOpen={() => onOpenPreset(preset)}
            />
          ))}
        </div>
      ) : null}
      {catalogLoaded && showFeatured && !category ? (
        <div className="mb-6" data-testid="featured-connectors">
          {catalog.length === 0 ? (
            !catalogsReady || plugins.length ? null : (
              <p className="text-body leading-6 text-muted-foreground/80">
                <Trans>Managed apps haven’t been enabled on this server.</Trans>
              </p>
            )
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {featuredTiles.map((tile) => {
                const item = tile.item;
                const key = item ? catalogItemKey(item) : tile.id;
                if (!item && presets.some(({ name }) => name === tile.label)) return null;
                const disabled = tile.missing || !item;
                if (item && !tile.missing) {
                  // Featured is the stable hit target for connection-tile-* in E2E.
                  return catalogTile(item, tile.label, item.logo, {
                    tileTestId: true,
                  });
                }
                return (
                  <div
                    key={key}
                    className={`flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2 ${
                      disabled ? "opacity-70" : ""
                    }`}
                  >
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-body font-semibold text-foreground">
                      {tile.label[0]}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-body-lg font-medium text-foreground">
                        {tile.label}
                      </div>
                      {disabled ? (
                        <div className="truncate text-body-sm text-muted-foreground">
                          <Trans>Not in the plugin catalog</Trans>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {searchingPublic && publicCatalog.isError && !waitingForPublic ? (
        <p role="status" className="pt-6 text-center text-body text-muted-foreground">
          <Trans>Could not load MCP servers.</Trans>
        </p>
      ) : null}
      {catalogsReady &&
      !waitingForPublic &&
      !(searchingPublic && publicCatalog.isError) &&
      !presets.length &&
      !remoteMatches.length &&
      visible.length === 0 &&
      !showFeatured &&
      !pluginMatches.length &&
      !brandMatches.length ? (
        <p className="pt-6 text-center text-body text-muted-foreground/80" role="status">
          {browsePublic && !searchingPublic ? (
            <Trans>No matches in your current catalogs.</Trans>
          ) : (
            <Trans>No apps match your search.</Trans>
          )}
        </p>
      ) : null}
      {showFeatured ? (
        <>
          {renderPluginSections()}
          {catalogLoaded && catalog.length > 0 && !category ? (
            <SectionHeading as="h2" className="mt-8 mb-2 px-2.5">
              <Trans>More apps</Trans>
            </SectionHeading>
          ) : null}
          {visible.length > 0 && !category ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {rendered.map((item) =>
                catalogTile(item, item.name, item.logo, {
                  // Avoid duplicate connection-tile-* ids while featured is also shown.
                  tileTestId: !showFeatured,
                }),
              )}
            </div>
          ) : null}
          {rendered.length < visible.length && !category ? (
            <div className="mt-4 flex justify-center">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setVisibleCount((count) => count + CONNECTION_CATALOG_PAGE_SIZE)}
              >
                <Trans>Show more</Trans>
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          {strongMatches.length > 0 && !category ? (
            <div className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {strongMatches.map((item) =>
                catalogTile(item, item.name, item.logo, { tileTestId: true }),
              )}
            </div>
          ) : null}
          {renderPluginSections()}
          {rendered.length > 0 && !category ? (
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {rendered.map((item) =>
                catalogTile(item, item.name, item.logo, { tileTestId: true }),
              )}
            </div>
          ) : null}
          {rendered.length < weakMatches.length && !category ? (
            <div className="mt-4 flex justify-center">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setVisibleCount((count) => count + CONNECTION_CATALOG_PAGE_SIZE)}
              >
                <Trans>Show more</Trans>
              </Button>
            </div>
          ) : null}

          {remoteMatches.length ? (
            <section data-testid="public-mcp-results" className="mt-8">
              <SectionHeading as="h2" className="mb-2 px-2.5">
                <Trans>Public MCP directory</Trans>
              </SectionHeading>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {remoteMatches.map((server) => {
                  const host = new URL(server.source).host;
                  return (
                    <PluginRow
                      key={server.source}
                      name={server.name}
                      description={host === server.name ? "" : host}
                      site={server.source}
                      installed={addedEndpoints.has(server.source)}
                      onOpen={() => onOpenMcp(server)}
                    />
                  );
                })}
              </div>
            </section>
          ) : null}
          {browsePublic && (!searchingPublic || publicCatalog.isError || waitingForPublic) ? (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                size="sm"
                disabled={waitingForPublic}
                onClick={() => {
                  if (searchingPublic) void publicCatalog.refetch();
                  else onSearchPublic(term);
                }}
              >
                {waitingForPublic ? (
                  <Trans>Searching…</Trans>
                ) : (
                  <Trans>Search public MCP directory for “{term}”</Trans>
                )}
              </Button>
            </div>
          ) : null}
        </>
      )}
      {catalogLoaded && !category ? (
        <div className="mt-10 flex justify-center">
          <a
            href={SUBMIT_PLUGIN_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-body-sm text-muted-foreground hover:text-foreground"
          >
            <Trans>Submit a plugin</Trans>
            <ArrowUpRight size={14} />
          </a>
        </div>
      ) : null}
    </>
  );
}
