import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type {
  CapabilityInstall,
  Connection,
  ConnectionCatalogItem,
  IntegrationCatalogResult,
  IntegrationCatalogSurface,
  PluginMarketplaceEntry,
} from "@rakazo/contracts";
import {
  CONNECTION_LABEL_MAX_LENGTH,
  PluginPreviewSchema,
  SUBMIT_PLUGIN_URL,
} from "@rakazo/contracts";
import type { PluginCategory } from "@rakazo/core";
import {
  buildFeaturedConnectorTiles,
  CONNECTION_CATALOG_PAGE_SIZE,
  catalogItemAccounts,
  catalogItemKey,
  connectCatalogItem,
  filterConnectionCatalogItems,
  humanizeToolName,
  installedPluginParts,
  isCatalogItemConnected,
  isRecommendedPlugin,
  managedAppFor,
  matchesPluginQuery,
  matchesWordPrefixes,
  OTHER_PLUGINS,
  PLUGIN_CATEGORIES,
} from "@rakazo/core";
import { fetchFresh, writeSaved } from "@rakazo/core/query";
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Disclosure,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Spinner,
} from "@rakazo/ui-web";
import { queryOptions, skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ChevronDown, ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { IntegrationSetup } from "../components/integrations/IntegrationSetup";
import type {
  ManagedAppLink,
  PluginSelection,
} from "../components/integrations/plugin-marketplace";
import {
  mcpServerReady,
  PluginDetail,
  PluginLogo,
  PluginRow,
  pluginSelection,
  ROW_HOVER,
} from "../components/integrations/plugin-marketplace";
import {
  AvailabilityControl,
  AvailabilityLabel,
  reachesOtherSpaces,
  useOwnSpaces,
} from "../components/integrations/space-availability";
import { connectedAppMarks } from "../lib/connected-apps";
import { optionalCatalogFeedProbe } from "../lib/optional-catalog-feed";
import { useSpaceQueries } from "../lib/query";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

function ConnectorIcon({ name, logo }: { name: string; logo?: string | null }) {
  return logo ? (
    <img
      src={logo}
      alt=""
      loading="lazy"
      decoding="async"
      className="h-9 w-9 shrink-0 rounded-xl bg-accent object-contain"
    />
  ) : (
    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-sm font-semibold text-foreground">
      {name[0]}
    </div>
  );
}

type SourceKind = "treg" | "executor" | "mcp" | "api" | "graphql";
type OverlayView = "browse" | "manage" | "github" | "source" | "browseMcp" | "domain";

const NO_CATALOG: ConnectionCatalogItem[] = [];
const NO_CONNECTIONS: Connection[] = [];
const NO_SOURCES: CapabilityInstall[] = [];
const NO_PLUGINS: PluginMarketplaceEntry[] = [];
const SECTION_SIZE = 6;
const CHIP_COUNT = 6;
const PLUGIN_PAGE_SIZE = 24;

/** "GMAIL_SEND_EMAIL" under Gmail reads as "Send email": the app is already the page title. */
function toolLabel(name: string, item: ConnectionCatalogItem) {
  const prefix = `${item.slug}_`;
  const bare = name.toLowerCase().startsWith(prefix.toLowerCase())
    ? name.slice(prefix.length)
    : name;
  return humanizeToolName(bare);
}

function markConnected(
  items: ConnectionCatalogItem[],
  connectorId: string,
  slug: string,
  connected: boolean,
) {
  return items.map((entry) =>
    entry.connectorId === connectorId && entry.slug === slug ? { ...entry, connected } : entry,
  );
}

export function PluginsOverlay({
  onConnectedAppsChange,
  onClose,
  onOpenMcp,
  activeBotId,
}: {
  onConnectedAppsChange?: (apps: ReturnType<typeof connectedAppMarks>) => void;
  onClose: () => void;
  onOpenMcp?: () => void;
  activeBotId?: string;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(CONNECTION_CATALOG_PAGE_SIZE);
  // Only accounts whose label is being edited; the rest follow the saved name.
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [sourceKind, setSourceKind] = useState<SourceKind | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [authType, setAuthType] = useState<"none" | "bearer" | "header">("bearer");
  const [authName, setAuthName] = useState("x-api-key");
  const [pending, setPending] = useState<string | null>(null);
  const [confirmingSource, setConfirmingSource] = useState<string | null>(null);
  const spaceCount = useOwnSpaces().length;
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceHint, setSourceHint] = useState<string | null>(null);
  const [catalogFeedQuery, setCatalogFeedQuery] = useState("");
  const [catalogFeedResults, setCatalogFeedResults] = useState<IntegrationCatalogResult[]>([]);
  const [catalogFeedError, setCatalogFeedError] = useState<string | null>(null);
  const [catalogFeedPending, setCatalogFeedPending] = useState(false);
  const [catalogFeedSearched, setCatalogFeedSearched] = useState(false);
  const [view, setView] = useState<OverlayView>("browse");
  // Where a source form returns: the domain search that prefilled it, or browse.
  const [sourceBack, setSourceBack] = useState<OverlayView>("browse");
  const [plugin, setPlugin] = useState<PluginSelection | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [pluginCount, setPluginCount] = useState(PLUGIN_PAGE_SIZE);
  const [gitSource, setGitSource] = useState("");
  const [detailKey, setDetailKey] = useState<{
    connectorId: string;
    slug: string;
  } | null>(null);
  const connectionAttempt = useRef<AbortController | null>(null);
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const mcpOptions = queries.mcp.servers.list.queryOptions();
  const mcpQuery = useQuery(mcpOptions);
  const mcpServers = mcpQuery.data ?? [];
  const mcpError = mcpQuery.error ? errorText(mcpQuery.error, t`Could not load MCP servers`) : null;
  async function loadIntegrations() {
    // The catalog call reconciles connection rows, so list them after it settles.
    const catalog = rpc.connections.catalog({});
    const [items, installs, rows, catalogFeed] = await Promise.all([
      catalog,
      rpc.capabilities.list(),
      catalog.catch(() => undefined).then(() => rpc.connections.list()),
      optionalCatalogFeedProbe(rpc.capabilities.catalogSearch({ query: "" })),
    ]);
    return {
      catalog: items,
      connections: rows,
      sources: installs.filter(
        (install) => install.kind === "mcp" || install.kind === "api" || install.kind === "graphql",
      ),
      plugins: installs.filter((install) => install.kind === "plugin"),
      catalogFeedEnabled: catalogFeed.enabled,
    };
  }
  const integrationsOptions = queryOptions({
    queryKey: [...queries.connections.catalog.queryKey({ input: {} }), "integrations"],
    queryFn: loadIntegrations,
  });
  const integrations = useQuery(integrationsOptions);
  const catalogLoaded = integrations.data !== undefined;
  const loading = !catalogLoaded && integrations.isFetching;
  const catalog = integrations.data?.catalog ?? NO_CATALOG;
  const connections = integrations.data?.connections ?? NO_CONNECTIONS;
  const sources = integrations.data?.sources ?? NO_SOURCES;
  const pluginInstalls = integrations.data?.plugins ?? NO_SOURCES;
  const pluginCatalog = useQuery(
    queries.marketplace.catalog.queryOptions({ input: { query: "" }, staleTime: 60_000 }),
  );
  const assignmentsQuery = useQuery(
    queries.mcp.assignments.list.queryOptions({
      input: activeBotId ? { botId: activeBotId } : skipToken,
    }),
  );
  const assigned = useMemo(
    () => new Set((assignmentsQuery.data ?? []).map((row) => row.serverId)),
    [assignmentsQuery.data],
  );
  const catalogFeedEnabled = integrations.data?.catalogFeedEnabled ?? false;
  // A failed refresh is shown even over what was cached, so stale apps never pass as current.
  const loadError = integrations.error
    ? errorText(integrations.error, t`Could not load integrations`)
    : null;
  const toolsQuery = useQuery(
    queries.connections.tools.queryOptions({
      input: detailKey
        ? { connectorId: detailKey.connectorId, provider: detailKey.slug }
        : skipToken,
    }),
  );
  const tools = (detailKey && toolsQuery.data) || [];
  const toolsLoading = detailKey !== null && toolsQuery.isPending && toolsQuery.isFetching;

  function updateIntegrations(
    update: (
      current: NonNullable<typeof integrations.data>,
    ) => NonNullable<typeof integrations.data>,
  ) {
    return writeSaved(queryClient, integrationsOptions.queryKey, (current) =>
      update(
        current ?? {
          catalog: NO_CATALOG,
          connections: NO_CONNECTIONS,
          sources: NO_SOURCES,
          plugins: NO_SOURCES,
          catalogFeedEnabled: false,
        },
      ),
    );
  }

  /** Reads integrations again with requests sent after a change. */
  async function refresh() {
    void fetchFresh(queryClient, mcpOptions).catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: queries.mcp.assignments.key() });
    await fetchFresh(queryClient, {
      queryKey: integrationsOptions.queryKey,
      queryFn: loadIntegrations,
    });
  }

  function refreshTools() {
    void queryClient.invalidateQueries({
      queryKey: queries.connections.tools.key(),
    });
  }

  useEffect(() => {
    return () => connectionAttempt.current?.abort();
  }, []);

  useEffect(() => {
    if (catalogLoaded) onConnectedAppsChange?.(connectedAppMarks(catalog, connections));
  }, [catalog, catalogLoaded, connections, onConnectedAppsChange]);

  const detailItem = useMemo(() => {
    if (!detailKey) return null;
    return (
      catalog.find(
        (entry) => entry.connectorId === detailKey.connectorId && entry.slug === detailKey.slug,
      ) ?? null
    );
  }, [catalog, detailKey]);

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
  // One row per brand: a plugin for a managed app lends that app its skills instead of being
  // listed again. Skill packs with nothing to connect belong to Skills, not here.
  const { plugins, pluginForApp } = useMemo(() => {
    const forApp = new Map<string, PluginMarketplaceEntry>();
    const listed: PluginMarketplaceEntry[] = [];
    for (const entry of catalogEntries) {
      const app = managedAppFor(entry, catalog);
      if (app) {
        if (entry.skillCount && !forApp.has(catalogItemKey(app)))
          forApp.set(catalogItemKey(app), entry);
      } else if (entry.hasConnector) listed.push(entry);
    }
    return { plugins: listed, pluginForApp: forApp };
  }, [catalog, catalogEntries]);
  const categoryLabels: Record<PluginCategory, string> = {
    productivity: t`Productivity`,
    communication: t`Communication`,
    sales: t`Sales & CRM`,
    marketing: t`Marketing`,
    finance: t`Finance`,
    people: t`Recruiting & HR`,
    design: t`Design`,
    code: t`Developer`,
    data: t`Data`,
    ops: t`Security & Ops`,
  };
  const categoryLabel = (name: string) => categoryLabels[name as PluginCategory] ?? name;
  // Managed apps standing in for a plugin keep that plugin's category, so a category lists them too.
  const mergedBrands = catalog.flatMap((item) => {
    const entry = pluginForApp.get(catalogItemKey(item));
    return entry ? [{ item, entry }] : [];
  });
  const categories: string[] = PLUGIN_CATEGORIES.filter(
    (name) =>
      plugins.some((entry) => entry.category === name) ||
      mergedBrands.some(({ entry }) => entry.category === name),
  );
  const brandMatches = category
    ? mergedBrands.filter(
        ({ item, entry }) =>
          entry.category === (category === OTHER_PLUGINS ? null : category) &&
          (matchesWordPrefixes(item.name, query) ||
            matchesPluginQuery(entry, query, categoryLabel(entry.category ?? ""))),
      )
    : [];
  const searching = query.trim().length > 0;
  const pluginMatches = plugins.filter(
    (entry) =>
      (!category || entry.category === (category === OTHER_PLUGINS ? null : category)) &&
      matchesPluginQuery(entry, query, entry.category ? categoryLabel(entry.category) : ""),
  );
  const installedPlugin = (installedSource: string) =>
    pluginInstalls.find((row) => row.source === installedSource);
  const pluginServers = (install: CapabilityInstall | undefined) =>
    install ? mcpServers.filter((server) => server.installId === install.id) : [];
  const standaloneServers = mcpServers.filter((server) => !server.installId);
  const connectedItems = catalog.filter((item) => itemConnected(item));
  // Skills live in their own dialog, so only installs with a connector count as apps here.
  const connectorInstalls = pluginInstalls.filter((install) =>
    installedPluginParts(install.config).includes("connector"),
  );
  const connectedCount =
    connectedItems.length + standaloneServers.length + sources.length + connectorInstalls.length;
  const connectedMarks = [
    ...connectedItems.map((item) => ({
      key: catalogItemKey(item),
      name: item.name,
      logo: item.logo,
    })),
    ...connectorInstalls.map((install) => {
      const entry = catalogEntries.find((row) => row.installedSource === install.source);
      return { key: install.id, name: entry?.displayName ?? install.name, logo: entry?.logo };
    }),
  ].slice(0, 4);

  const browsing = !plugin && !detailItem && view === "browse";

  function openPlugin(selection: PluginSelection) {
    setCatalogError(null);
    setPlugin(selection);
  }

  /** A managed app whose brand also has a plugin opens one page with its skills. */
  function openApp(item: ConnectionCatalogItem) {
    const entry = pluginForApp.get(catalogItemKey(item));
    if (entry) openPlugin(pluginSelection(entry));
    else openDetail(item);
  }

  const appForPlugin = (selection: PluginSelection) => {
    const entry = catalogEntries.find((row) => row.installedSource === selection.installedSource);
    return entry ? managedAppFor(entry, catalog) : undefined;
  };

  function installedSelection(install: CapabilityInstall): PluginSelection {
    const entry = catalogEntries.find((row) => row.installedSource === install.source);
    return entry
      ? pluginSelection(entry)
      : { source: install.source, installedSource: install.source, name: install.name };
  }

  function managedLink(selection: PluginSelection): ManagedAppLink | undefined {
    const item = appForPlugin(selection);
    if (!item) return undefined;
    return {
      name: item.name,
      logo: item.logo,
      connected: itemConnected(item),
      connecting: pending === catalogItemKey(item),
      onConnect: () => void connect(item),
      onManage: () => {
        setPlugin(null);
        openDetail(item);
      },
    };
  }

  function openDetail(item: ConnectionCatalogItem) {
    setCatalogError(null);
    setDetailKey({ connectorId: item.connectorId, slug: item.slug });
  }

  function closeDetail() {
    setDetailKey(null);
  }

  function itemConnected(item: ConnectionCatalogItem) {
    return isCatalogItemConnected(connections, item);
  }

  async function notifyAppConnected(item: ConnectionCatalogItem) {
    if (!activeBotId) return;
    await rpc.onboarding
      .appConnected({
        botId: activeBotId,
        provider: item.slug,
        connectorId: item.connectorId,
      })
      .catch(() => undefined);
  }

  function setItemConnected(item: ConnectionCatalogItem, connected: boolean) {
    return updateIntegrations((current) => ({
      ...current,
      catalog: markConnected(current.catalog, item.connectorId, item.slug, connected),
    }));
  }

  async function connect(item: ConnectionCatalogItem) {
    connectionAttempt.current?.abort();
    const controller = new AbortController();
    connectionAttempt.current = controller;
    setCatalogError(null);
    const key = catalogItemKey(item);
    setPending(key);
    try {
      const result = await connectCatalogItem(item, connections, {
        begin: (input) => rpc.connections.begin(input),
        complete: (input) => rpc.connections.complete(input),
        openUrl: (url) => window.open(url, "rakazo-plugin-connect", "noopener,noreferrer"),
        signal: controller.signal,
      });
      if (result.status === "aborted") return;
      if (result.status === "connected") {
        await setItemConnected(item, true);
        void notifyAppConnected(item);
        await refresh().catch(() => undefined);
        refreshTools();
        return;
      }
      setCatalogError(
        t`Connection to ${item.name} is still pending. You can close this and check again.`,
      );
      await refresh().catch(() => undefined);
    } catch (err) {
      if (controller.signal.aborted) return;
      setCatalogError(errorText(err, t`Could not connect`));
    } finally {
      if (connectionAttempt.current === controller) {
        connectionAttempt.current = null;
        setPending(null);
      }
    }
  }

  async function revokeAccount(row: Connection, item: ConnectionCatalogItem) {
    setCatalogError(null);
    setPending(row.id);
    try {
      await rpc.connections.revoke({ connectionId: row.id });
      const remaining = catalogItemAccounts(connections, item).filter(
        (entry) => entry.id !== row.id,
      );
      if (remaining.every((entry) => entry.status !== "connected")) {
        await setItemConnected(item, false);
      }
      await refresh().catch(() => undefined);
      refreshTools();
    } catch (err) {
      setCatalogError(errorText(err, t`Could not revoke connection`));
    } finally {
      setPending(null);
    }
  }

  async function uninstall(item: ConnectionCatalogItem) {
    const matches = catalogItemAccounts(connections, item);
    if (matches.length === 0) {
      void setItemConnected(item, false);
      closeDetail();
      return;
    }
    setCatalogError(null);
    setPending(`uninstall:${catalogItemKey(item)}`);
    try {
      for (const row of matches) {
        await rpc.connections.revoke({ connectionId: row.id });
      }
      await setItemConnected(item, false);
      await refresh().catch(() => undefined);
      closeDetail();
    } catch (err) {
      setCatalogError(errorText(err, t`Could not revoke connection`));
      await refresh().catch(() => undefined);
    } finally {
      setPending(null);
    }
  }

  async function renameAccount(row: Connection) {
    const displayName = (labelDrafts[row.id] ?? row.displayName).trim();
    const clearDraft = () => setLabelDrafts(({ [row.id]: _draft, ...rest }) => rest);
    if (!displayName || displayName === row.displayName) {
      clearDraft();
      return;
    }
    setPending(`rename:${row.id}`);
    setCatalogError(null);
    try {
      const updated = await rpc.connections.rename({
        connectionId: row.id,
        displayName,
      });
      await updateIntegrations((current) => ({
        ...current,
        connections: current.connections.map((entry) =>
          entry.id === row.id ? { ...entry, displayName: updated.displayName } : entry,
        ),
      }));
      clearDraft();
    } catch (err) {
      setCatalogError(errorText(err, t`Could not rename connection`));
    } finally {
      setPending(null);
    }
  }

  function beginSource(kind: SourceKind) {
    setPlugin(null);
    setDetailKey(null);
    setSourceBack("browse");
    setView("source");
    setSourceKind(kind);
    setSourceError(null);
    setSourceHint(null);
    setSourceName(kind === "treg" ? "Treg" : kind === "executor" ? "Executor" : "");
    setSourceUrl(kind === "treg" ? "https://treg.to/mcp/" : "");
    setCredential("");
    setAuthType(kind === "treg" || kind === "executor" ? "bearer" : "none");
    setAuthName("x-api-key");
  }

  async function searchCatalogFeed() {
    setCatalogFeedError(null);
    setCatalogFeedPending(true);
    setCatalogFeedSearched(false);
    setCatalogFeedResults([]);
    try {
      const response = await rpc.capabilities.catalogSearch({
        query: catalogFeedQuery,
      });
      setCatalogFeedResults(response.results);
      setCatalogFeedSearched(true);
    } catch (err) {
      setCatalogFeedError(errorText(err, t`Could not search catalog`));
    } finally {
      setCatalogFeedPending(false);
    }
  }

  function beginCatalogSurface(
    result: IntegrationCatalogResult,
    surface: IntegrationCatalogSurface,
  ) {
    if (!surface.source || (surface.kind !== "mcp" && surface.kind !== "openapi")) return;
    setSourceBack("domain");
    setView("source");
    setSourceKind(surface.kind === "mcp" ? "mcp" : "api");
    setSourceName(result.name);
    setSourceUrl(surface.source);
    setCredential("");
    setAuthType(surface.auth?.type ?? "none");
    setAuthName(surface.auth?.headerName ?? "x-api-key");
    setSourceHint(surface.auth?.note ?? null);
    setSourceError(null);
  }

  async function installSource() {
    if (!sourceKind) return;
    setSourceError(null);
    setPending("install-source");
    try {
      const auth = {
        type: authType,
        ...(authType === "header" ? { name: authName.trim() } : {}),
      };
      await rpc.capabilities.install({
        kind: sourceKind === "treg" || sourceKind === "executor" ? "mcp" : sourceKind,
        name:
          sourceName.trim() ||
          (sourceKind === "treg"
            ? "Treg"
            : sourceKind === "executor"
              ? "Executor"
              : sourceKind === "graphql"
                ? "GraphQL"
                : "Custom connector"),
        source: sourceUrl.trim(),
        credential: credential.trim() || undefined,
        config:
          sourceKind === "treg"
            ? { preset: "treg", auth: { type: "bearer" } }
            : sourceKind === "api"
              ? { openApi: true, auth }
              : sourceKind === "graphql"
                ? { auth }
                : {
                    preset: "custom",
                    auth: sourceKind === "executor" ? { type: "bearer" } : auth,
                  },
      });
      setCredential("");
      setSourceKind(null);
      setView("manage");
      await refresh();
    } catch (err) {
      setSourceError(errorText(err, t`Could not install connector`));
    } finally {
      setPending(null);
    }
  }

  async function removeSource(install: CapabilityInstall) {
    if (reachesOtherSpaces(install.availability, spaceCount) && confirmingSource !== install.id) {
      setConfirmingSource(install.id);
      return;
    }
    setConfirmingSource(null);
    setPending(install.id);
    setSourceError(null);
    try {
      await rpc.capabilities.remove({ id: install.id });
      await updateIntegrations((current) => ({
        ...current,
        sources: current.sources.filter((source) => source.id !== install.id),
      }));
    } catch (err) {
      setSourceError(errorText(err, t`Could not remove connector`));
    } finally {
      setPending(null);
    }
  }

  function renderCatalogActions(item: ConnectionCatalogItem) {
    const key = catalogItemKey(item);
    const connected = itemConnected(item);
    const connecting = pending === key;
    if (connected) {
      return (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={connecting}
          onClick={(event) => {
            event.stopPropagation();
            openDetail(item);
          }}
        >
          {connecting ? <Trans>Adding…</Trans> : <Trans>Added</Trans>}
        </Button>
      );
    }
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={connecting}
        onClick={(event) => {
          event.stopPropagation();
          void connect(item);
        }}
      >
        {connecting ? <Trans>Adding…</Trans> : <Trans>Add</Trans>}
      </Button>
    );
  }

  function renderCatalogTile(
    item: ConnectionCatalogItem,
    label: string,
    logo?: string | null,
    opts?: { tileTestId?: boolean },
  ) {
    const connected = itemConnected(item);
    const openable = connected || pluginForApp.has(catalogItemKey(item));
    const tileTestId = opts?.tileTestId !== false && connected;
    const icon = <ConnectorIcon name={label} logo={logo} />;
    const title = (
      <div className="min-w-0 flex-1 text-start">
        <div className="truncate text-[15px] font-medium text-foreground">{label}</div>
      </div>
    );
    return (
      <div
        key={catalogItemKey(item)}
        data-testid={tileTestId ? `connection-tile-${item.slug.toLowerCase()}` : undefined}
        className={`flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2${openable ? ` ${ROW_HOVER}` : ""}`}
      >
        {openable ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-3 text-start focus-visible:outline-none"
            onClick={() => openApp(item)}
          >
            {icon}
            {title}
          </button>
        ) : (
          <>
            {icon}
            {title}
          </>
        )}
        {renderCatalogActions(item)}
      </div>
    );
  }

  function renderDetail(item: ConnectionCatalogItem) {
    const accounts = catalogItemAccounts(connections, item);
    const key = catalogItemKey(item);
    const connecting = pending === key;
    const uninstalling = pending === `uninstall:${key}`;
    const toolCount = tools.length;

    return (
      <div data-testid="connection-detail" className="space-y-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label={t`Back`}
              onClick={closeDetail}
            >
              <ChevronLeft />
            </Button>
            {item.logo ? (
              <img
                src={item.logo}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-9 w-9 shrink-0 rounded-xl bg-accent object-contain"
              />
            ) : (
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-sm font-semibold text-foreground">
                {item.name[0]}
              </div>
            )}
            <div className="truncate text-[17px] font-medium text-foreground">{item.name}</div>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={uninstalling || connecting}
            onClick={() => void uninstall(item)}
          >
            {uninstalling ? <Trans>Removing…</Trans> : <Trans>Uninstall</Trans>}
          </Button>
        </div>

        <section data-testid="connection-accounts" className="space-y-1">
          {accounts.map((row) => (
            <div key={row.id} className="group/account flex items-center gap-2">
              <Input
                value={labelDrafts[row.id] ?? row.displayName}
                aria-label={t`Account label`}
                maxLength={CONNECTION_LABEL_MAX_LENGTH}
                className="h-9 rounded-lg border-transparent bg-transparent px-2 text-[14px] shadow-none hover:bg-accent/60 focus-visible:bg-background dark:bg-transparent"
                onChange={(event) =>
                  setLabelDrafts((current) => ({
                    ...current,
                    [row.id]: event.target.value,
                  }))
                }
                onBlur={() => void renameAccount(row)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) {
                    if (event.key === "Escape") event.stopPropagation();
                    return;
                  }
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
              />
              <Button
                type="button"
                variant="ghost"
                className="h-8 shrink-0 px-2.5 text-[12px] text-muted-foreground pointer-fine:opacity-0 pointer-fine:group-focus-within/account:opacity-100 pointer-fine:group-hover/account:opacity-100"
                size="sm"
                disabled={pending === row.id || uninstalling}
                onClick={() => void revokeAccount(row, item)}
              >
                {pending === row.id ? <Trans>Removing…</Trans> : <Trans>Remove</Trans>}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            className="h-9 px-2 text-[14px] text-muted-foreground"
            size="sm"
            disabled={connecting || uninstalling}
            onClick={() => void connect(item)}
          >
            <Plus />
            {connecting ? <Trans>Adding…</Trans> : <Trans>Add another</Trans>}
          </Button>
        </section>

        {toolsLoading || tools.length > 0 ? (
          <Disclosure
            data-testid="connection-tools"
            className="px-2"
            summaryClassName="text-[13px] text-muted-foreground"
            summary={
              toolsLoading ? (
                <Trans>Tools</Trans>
              ) : (
                <Plural value={toolCount} one="# tool" other="# tools" />
              )
            }
          >
            <div className="flex flex-wrap gap-1.5 pt-3">
              {tools.map((tool) => (
                <Badge
                  key={tool.name}
                  variant="secondary"
                  className="h-6 px-2.5 text-[12px] font-normal"
                  title={tool.description || undefined}
                >
                  {toolLabel(tool.name, item)}
                </Badge>
              ))}
            </div>
          </Disclosure>
        ) : null}
      </div>
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
        onOpen={() => openPlugin(selection)}
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
        <div role="alert" className="mt-6 flex items-center gap-3 text-sm text-muted-foreground">
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
          <div className="grid grid-cols-2 gap-2">
            {brandMatches.map(({ item }) => renderCatalogTile(item, item.name, item.logo))}
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
            <h2 className="mb-2 px-2.5 text-[15px] font-medium text-foreground">
              <Trans>Recommended</Trans>
            </h2>
            <div className="grid grid-cols-2 gap-2">
              {recommended.map(({ entry, item }) =>
                item ? renderCatalogTile(item, item.name, item.logo) : renderPluginRow(entry),
              )}
            </div>
          </section>
        ) : null}
        {sections.map(([name, label, entries]) => (
          <section key={name} data-testid="plugin-section" className="mt-8">
            <div className="mb-2 flex items-center justify-between px-2.5">
              <h2 className="text-[15px] font-medium text-foreground">{label}</h2>
              {entries.length > SECTION_SIZE ? (
                <Button variant="text" size="sm" onClick={() => setCategory(name)}>
                  <Trans>View all</Trans>
                </Button>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {entries.slice(0, SECTION_SIZE).map(renderPluginRow)}
            </div>
          </section>
        ))}
      </>
    );
  }

  function openAddView(next: OverlayView) {
    setPlugin(null);
    setDetailKey(null);
    setSourceError(null);
    setView(next);
  }

  function leaveSource() {
    setSourceKind(null);
    setSourceError(null);
    setSourceHint(null);
    setView(sourceBack);
  }

  function renderAddMenu() {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label={t`Add custom`} />}
        >
          <Plus />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={() => openAddView("github")}>
            <Trans>From GitHub</Trans>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => beginSource("mcp")}>
            <Trans>MCP server</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => beginSource("api")}>OpenAPI</DropdownMenuItem>
          <DropdownMenuItem onClick={() => beginSource("graphql")}>GraphQL</DropdownMenuItem>
          <DropdownMenuItem onClick={() => beginSource("executor")}>Executor</DropdownMenuItem>
          <DropdownMenuItem onClick={() => beginSource("treg")}>Treg</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => openAddView("browseMcp")}>
            <Trans>Browse MCP servers</Trans>
          </DropdownMenuItem>
          {catalogFeedEnabled ? (
            <DropdownMenuItem onClick={() => openAddView("domain")}>
              <Trans>Search by domain</Trans>
            </DropdownMenuItem>
          ) : null}
          {onOpenMcp ? (
            <DropdownMenuItem onClick={onOpenMcp}>
              <Trans>Manage MCP servers</Trans>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  function renderViewTitle(title: ReactNode, onBack: () => void) {
    return (
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="-ms-2 text-muted-foreground"
          aria-label={t`Back`}
          onClick={onBack}
        >
          <ChevronLeft />
        </Button>
        <h2 className="text-[17px] font-medium text-foreground">{title}</h2>
      </div>
    );
  }

  function renderGithubImport() {
    return (
      <div data-testid="plugin-git-import" className="max-w-xl space-y-6">
        {renderViewTitle(<Trans>From GitHub</Trans>, () => setView("browse"))}
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const source = gitSource.trim();
            if (!source) return;
            openPlugin({
              source,
              installedSource: source.replace(/\/$/, ""),
              name: source.replace(/\/$/, "").split("/").pop() ?? source,
            });
          }}
        >
          <Field>
            <FieldLabel htmlFor="plugin-git-url">
              <Trans>Plugin GitHub URL</Trans>
            </FieldLabel>
            <Input
              id="plugin-git-url"
              value={gitSource}
              onChange={(event) => setGitSource(event.target.value)}
              placeholder="https://github.com/owner/plugin"
              maxLength={2048}
              autoFocus
            />
          </Field>
          <Button type="submit" disabled={!gitSource.trim()}>
            <Trans>Preview</Trans>
          </Button>
        </form>
      </div>
    );
  }

  function renderSourceForm() {
    if (!sourceKind) return null;
    const custom = sourceKind !== "treg" && sourceKind !== "executor";
    return (
      <div data-testid="integrations-source-form" className="max-w-xl space-y-6">
        {renderViewTitle(
          sourceKind === "treg" ? (
            "Treg"
          ) : sourceKind === "executor" ? (
            "Executor"
          ) : sourceKind === "mcp" ? (
            <Trans>MCP server</Trans>
          ) : sourceKind === "graphql" ? (
            "GraphQL"
          ) : (
            "OpenAPI"
          ),
          leaveSource,
        )}
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void installSource();
          }}
        >
          <Field>
            <FieldLabel htmlFor="source-name">
              <Trans>Name</Trans>
            </FieldLabel>
            <Input
              id="source-name"
              value={sourceName}
              onChange={(event) => setSourceName(event.target.value)}
              autoFocus
            />
          </Field>
          {sourceKind !== "treg" ? (
            <Field>
              <FieldLabel htmlFor="source-url">URL</FieldLabel>
              <Input
                id="source-url"
                value={sourceUrl}
                onChange={(event) => setSourceUrl(event.target.value)}
                placeholder={
                  sourceKind === "mcp"
                    ? "https://example.com/mcp"
                    : sourceKind === "executor"
                      ? "https://executor.example/mcp"
                      : sourceKind === "graphql"
                        ? "https://example.com/graphql"
                        : "https://example.com/openapi.json"
                }
              />
            </Field>
          ) : null}
          {custom ? (
            <Field>
              <FieldLabel htmlFor="source-auth">
                <Trans>Authentication</Trans>
              </FieldLabel>
              <NativeSelect
                id="source-auth"
                className="w-full"
                value={authType}
                onChange={(event) => setAuthType(event.target.value as typeof authType)}
              >
                <NativeSelectOption value="none">
                  <Trans>No authentication</Trans>
                </NativeSelectOption>
                <NativeSelectOption value="bearer">
                  <Trans>Bearer token</Trans>
                </NativeSelectOption>
                <NativeSelectOption value="header">
                  <Trans>API key header</Trans>
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          ) : null}
          {custom && authType === "header" ? (
            <Field>
              <FieldLabel htmlFor="source-header">
                <Trans>Header name</Trans>
              </FieldLabel>
              <Input
                id="source-header"
                value={authName}
                onChange={(event) => setAuthName(event.target.value)}
              />
            </Field>
          ) : null}
          {!custom || authType !== "none" ? (
            <Field>
              <FieldLabel htmlFor="source-credential">
                {sourceKind === "treg" ? (
                  <Trans>Treg token</Trans>
                ) : sourceKind === "executor" ? (
                  <Trans>Executor token</Trans>
                ) : (
                  <Trans>Credential</Trans>
                )}
              </FieldLabel>
              <Input
                id="source-credential"
                type="password"
                autoComplete="new-password"
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
              />
              <FieldDescription>
                <Trans>Credentials are encrypted and never sent to the model.</Trans>
              </FieldDescription>
            </Field>
          ) : null}
          {sourceHint ? <p className="text-sm text-muted-foreground">{sourceHint}</p> : null}
          {sourceError ? (
            <p role="alert" className="text-sm text-destructive">
              {sourceError}
            </p>
          ) : null}
          <Button type="submit" disabled={pending === "install-source"}>
            {pending === "install-source" ? (
              <Trans>Verifying…</Trans>
            ) : (
              <Trans>Verify and add</Trans>
            )}
          </Button>
        </form>
      </div>
    );
  }

  function renderDomainSearch() {
    return (
      <div data-testid="integrations-catalog-feed" className="max-w-2xl space-y-6">
        {renderViewTitle(<Trans>Search by domain</Trans>, () => setView("browse"))}
        <div className="space-y-3">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void searchCatalogFeed();
            }}
          >
            <Input
              value={catalogFeedQuery}
              disabled={catalogFeedPending}
              onChange={(event) => {
                setCatalogFeedQuery(event.target.value);
                setCatalogFeedResults([]);
                setCatalogFeedError(null);
                setCatalogFeedSearched(false);
              }}
              placeholder="github.com"
              aria-label={t`Integration domain`}
            />
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              disabled={!catalogFeedQuery.trim() || catalogFeedPending}
            >
              {catalogFeedPending ? <Trans>Searching…</Trans> : <Trans>Search</Trans>}
            </Button>
          </form>
          {catalogFeedError ? <p className="text-sm text-destructive">{catalogFeedError}</p> : null}
          {catalogFeedSearched && !catalogFeedPending && catalogFeedResults.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <Trans>No results</Trans>
            </p>
          ) : null}
          {catalogFeedResults.map((result) => (
            <div
              key={`${result.domain}:${result.name}:${result.pageUrl ?? ""}`}
              className="rounded-xl border border-border/70 p-3"
            >
              <div className="font-medium text-foreground">
                {result.pageUrl ? (
                  <a
                    href={result.pageUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:underline"
                  >
                    {result.name}
                  </a>
                ) : (
                  result.name
                )}
              </div>
              <div className="text-xs text-muted-foreground">{result.domain}</div>
              {result.description ? (
                <p className="mt-2 text-sm leading-5 text-muted-foreground">{result.description}</p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                {result.surfaces.map((surface) => {
                  const canAdd =
                    Boolean(surface.source) &&
                    (surface.kind === "mcp" || surface.kind === "openapi");
                  return (
                    <Button
                      key={`${result.domain}:${surface.slug}`}
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={!canAdd}
                      title={canAdd ? undefined : t`Manual setup required`}
                      onClick={() => beginCatalogSurface(result, surface)}
                    >
                      <span>{surface.kind.toUpperCase()}</span>
                      <span>{canAdd ? t`Add` : t`Manual`}</span>
                    </Button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function renderBrowseMcp() {
    return (
      <div className="space-y-6">
        {renderViewTitle(<Trans>Browse MCP servers</Trans>, () => setView("browse"))}
        <IntegrationSetup
          botId={activeBotId}
          onDone={() => {
            setView("manage");
            void refresh().catch((err: unknown) =>
              setCatalogError(errorText(err, t`Could not load integrations`)),
            );
          }}
        />
      </div>
    );
  }

  function renderInstalledPlugin(install: CapabilityInstall, part: "connector" | "skills") {
    const selection = installedSelection(install);
    const servers = pluginServers(install);
    const parsed = PluginPreviewSchema.safeParse(install.config);
    const skillCount = parsed.success ? parsed.data.skills.length : 0;
    const signInNeeded = part === "connector" && !servers.every(mcpServerReady);
    return (
      <div
        key={`${install.id}:${part}`}
        data-testid="installed-plugin"
        className={`flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2 ${ROW_HOVER}`}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 text-start focus-visible:outline-none"
          onClick={() => openPlugin(selection)}
        >
          <PluginLogo name={selection.name} logo={selection.logo} site={selection.site} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-medium">{selection.name}</span>
            <span className="block truncate text-[13px] text-muted-foreground">
              {part === "connector" ? (
                <Plural value={servers.length} one="# connector" other="# connectors" />
              ) : (
                <Plural value={skillCount} one="# skill" other="# skills" />
              )}
            </span>
          </span>
        </button>
        <AvailabilityLabel availability={install.availability} />
        {signInNeeded ? (
          <Button variant="secondary" size="sm" onClick={() => openPlugin(selection)}>
            <Trans>Sign in</Trans>
          </Button>
        ) : null}
      </div>
    );
  }

  function renderManage() {
    const appPlugins = connectorInstalls;
    const hasApps = connectedCount > 0 || Boolean(mcpError);
    const sectionTitle = "mb-2 px-2.5 text-[14px] font-medium text-muted-foreground";
    return (
      <div data-testid="integrations-manage" className="space-y-8">
        {renderViewTitle(<Trans>Connected</Trans>, () => setView("browse"))}

        {hasApps ? (
          <section data-testid="connected-apps">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className={sectionTitle}>
                <Trans>Apps</Trans>
              </h3>
              {onOpenMcp && standaloneServers.length ? (
                <Button variant="link" size="xs" onClick={onOpenMcp}>
                  <Trans>Manage MCP servers</Trans>
                </Button>
              ) : null}
            </div>
            {mcpError ? (
              <div
                role="alert"
                className="mb-2 flex items-center gap-2 px-2.5 text-sm text-destructive"
              >
                {mcpError}
                <Button variant="link" size="xs" onClick={() => void mcpQuery.refetch()}>
                  <Trans>Retry</Trans>
                </Button>
              </div>
            ) : null}
            {sourceError ? (
              <p role="alert" className="mb-2 px-2.5 text-sm text-destructive">
                {sourceError}
              </p>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
              {connectedItems.map((item) =>
                renderCatalogTile(item, item.name, item.logo, { tileTestId: false }),
              )}
              {appPlugins.map((install) => renderInstalledPlugin(install, "connector"))}
              <div data-testid="registered-mcp-servers" className="contents">
                {standaloneServers.map((server) => (
                  <div
                    key={server.id}
                    data-testid="registered-mcp-server"
                    className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2"
                  >
                    <ConnectorIcon name={server.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium">{server.name}</span>
                      <span className="block truncate text-[13px] text-muted-foreground">
                        {!server.enabled ? (
                          <Trans>Disabled</Trans>
                        ) : server.oauthStatus === "reconnect" ? (
                          <Trans>OAuth expired</Trans>
                        ) : server.oauthStatus === "connected" ? (
                          <Trans>OAuth connected</Trans>
                        ) : server.hasSecret ? (
                          <Trans>Credential saved</Trans>
                        ) : (
                          <Trans>No auth</Trans>
                        )}
                      </span>
                    </span>
                    <AvailabilityLabel availability={server.availability} />
                  </div>
                ))}
              </div>
              <div data-testid="tool-sources" className="contents">
                {sources.map((source) => (
                  <div
                    key={source.id}
                    data-testid="tool-source"
                    className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2"
                  >
                    <ConnectorIcon name={source.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium">{source.name}</span>
                      <span className="block truncate text-[13px] text-muted-foreground">
                        {source.kind === "api"
                          ? "OpenAPI"
                          : source.kind === "graphql"
                            ? "GraphQL"
                            : "MCP"}{" "}
                        {source.source}
                      </span>
                      <span className="mt-1 block">
                        <AvailabilityControl
                          kind="install"
                          id={source.id}
                          availability={source.availability}
                          onChanged={refresh}
                        />
                      </span>
                    </span>
                    <Button
                      type="button"
                      variant={confirmingSource === source.id ? "destructive" : "secondary"}
                      size="sm"
                      disabled={pending === source.id}
                      onClick={() => void removeSource(source)}
                    >
                      {pending === source.id ? (
                        <Trans>Removing…</Trans>
                      ) : confirmingSource === source.id ? (
                        <Trans>Remove from every space?</Trans>
                      ) : (
                        <Trans>Remove</Trans>
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </section>
        ) : null}
      </div>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[760px] max-h-[calc(100%-2rem)] w-[1080px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-card p-0 sm:max-w-[1080px]"
      >
        <DialogHeader className="flex-row items-start justify-between px-8 pt-7">
          <DialogTitle className="text-heading2 text-foreground">
            <Trans>Integrations</Trans>
          </DialogTitle>
          <div className="flex items-center gap-2">
            {browsing && connectedCount > 0 ? (
              <Button
                variant="ghost"
                className="-my-1 h-9 gap-2.5 px-2.5 text-[14px] text-muted-foreground"
                onClick={() => setView("manage")}
              >
                <span aria-hidden className="flex -space-x-1.5">
                  {connectedMarks.map((mark) => (
                    <span key={mark.key} className="rounded-[9px] ring-2 ring-card">
                      {mark.logo ? (
                        <img
                          src={mark.logo}
                          alt=""
                          className="h-6 w-6 rounded-lg bg-favicon-plate object-contain p-0.5"
                        />
                      ) : (
                        <span className="grid h-6 w-6 place-items-center rounded-lg border border-border/60 bg-favicon-plate text-[11px] font-semibold text-foreground">
                          {mark.name[0]?.toUpperCase()}
                        </span>
                      )}
                    </span>
                  ))}
                </span>
                <Plural value={connectedCount} one="# connected" other="# connected" />
                <ChevronRight />
              </Button>
            ) : null}
            {browsing || view === "manage" ? renderAddMenu() : null}
            <DialogClose
              render={<Button variant="ghost" size="icon-sm" aria-label={t`Close integrations`} />}
            >
              <X />
            </DialogClose>
          </div>
        </DialogHeader>

        {browsing ? (
          <div className="space-y-4 px-8 pt-4">
            <Input
              disabled={loading}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setVisibleCount(CONNECTION_CATALOG_PAGE_SIZE);
              }}
              aria-label={t`Search apps`}
              placeholder={t`Search apps`}
              className="h-11 rounded-xl px-4 md:text-[15px]"
            />
            {categories.length >= 2 || category ? (
              <div className="flex flex-wrap gap-2" data-testid="integration-categories">
                {[null, ...categories.slice(0, CHIP_COUNT)].map((name) => (
                  <Button
                    key={name ?? "all"}
                    type="button"
                    size="sm"
                    variant={category === name ? "default" : "secondary"}
                    aria-pressed={category === name}
                    className="h-8 rounded-full px-3.5 text-[13px]"
                    onClick={() => {
                      setCategory(name);
                      setPluginCount(PLUGIN_PAGE_SIZE);
                    }}
                  >
                    {name ? categoryLabel(name) : <Trans>All</Trans>}
                  </Button>
                ))}
                {categories.length > CHIP_COUNT ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          type="button"
                          size="sm"
                          variant={
                            category && !categories.slice(0, CHIP_COUNT).includes(category)
                              ? "default"
                              : "secondary"
                          }
                          className="h-8 rounded-full px-3.5 text-[13px]"
                        />
                      }
                    >
                      {category && !categories.slice(0, CHIP_COUNT).includes(category) ? (
                        categoryLabel(category)
                      ) : (
                        <Trans>More</Trans>
                      )}
                      <ChevronDown />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-auto">
                      {categories.slice(CHIP_COUNT).map((name) => (
                        <DropdownMenuItem
                          key={name}
                          onClick={() => {
                            setCategory(name);
                            setPluginCount(PLUGIN_PAGE_SIZE);
                          }}
                        >
                          {categoryLabel(name)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {loading ? (
          <div className="grid flex-1 place-items-center" aria-busy="true">
            <Spinner
              className="size-5 text-muted-foreground"
              aria-label={t`Loading integrations…`}
            />
          </div>
        ) : null}

        <div
          id="integration-list"
          hidden={loading}
          className="rk-scroll flex-1 overflow-y-auto px-8 py-6"
        >
          {catalogError || loadError ? (
            <div className="mb-4 flex items-center gap-3">
              <p className="text-sm text-destructive">{catalogError ?? loadError}</p>
              {!catalogLoaded || (loadError && !catalogError) ? (
                <Button variant="outline" size="sm" onClick={() => void integrations.refetch()}>
                  <Trans>Retry</Trans>
                </Button>
              ) : null}
            </div>
          ) : null}

          {plugin ? (
            <PluginDetail
              key={plugin.installedSource}
              selection={plugin}
              installs={pluginInstalls}
              servers={mcpServers}
              assigned={assigned}
              activeBotId={activeBotId}
              managed={managedLink(plugin)}
              onBack={() => setPlugin(null)}
              onChanged={refresh}
            />
          ) : detailItem ? (
            renderDetail(detailItem)
          ) : view === "manage" ? (
            renderManage()
          ) : view === "github" ? (
            renderGithubImport()
          ) : view === "source" ? (
            renderSourceForm()
          ) : view === "domain" ? (
            renderDomainSearch()
          ) : view === "browseMcp" ? (
            renderBrowseMcp()
          ) : (
            <>
              {catalogLoaded && showFeatured && !category ? (
                <div className="mb-6" data-testid="featured-connectors">
                  {catalog.length === 0 ? (
                    plugins.length ? null : (
                      <p className="text-[13.5px] leading-6 text-muted-foreground/80">
                        <Trans>Configure a plugin catalog on the server to connect apps.</Trans>
                      </p>
                    )
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      {featuredTiles.map((tile) => {
                        const item = tile.item;
                        const key = item ? catalogItemKey(item) : tile.id;
                        const disabled = tile.missing || !item;
                        if (item && !tile.missing) {
                          // Featured is the stable hit target for connection-tile-* in E2E.
                          return renderCatalogTile(item, tile.label, item.logo, {
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
                            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-sm font-semibold text-foreground">
                              {tile.label[0]}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[15px] font-medium text-foreground">
                                {tile.label}
                              </div>
                              {disabled ? (
                                <div className="truncate text-[12.5px] text-muted-foreground">
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

              {catalogLoaded &&
              catalog.length === 0 &&
              !showFeatured &&
              !pluginMatches.length &&
              !brandMatches.length ? (
                <p className="text-muted-foreground/80">
                  <Trans>No managed app catalog is configured on this deployment.</Trans>
                </p>
              ) : null}
              {catalogLoaded &&
              visible.length === 0 &&
              !showFeatured &&
              !pluginMatches.length &&
              !brandMatches.length ? (
                <p className="text-muted-foreground/80">
                  <Trans>No apps match your search.</Trans>
                </p>
              ) : null}
              {showFeatured ? (
                <>
                  {renderPluginSections()}
                  {catalogLoaded && catalog.length > 0 && !category ? (
                    <h2 className="mt-8 mb-2 px-2.5 text-[15px] font-medium text-foreground">
                      <Trans>More apps</Trans>
                    </h2>
                  ) : null}
                  {visible.length > 0 && !category ? (
                    <div className="grid grid-cols-2 gap-2">
                      {rendered.map((item) =>
                        renderCatalogTile(item, item.name, item.logo, {
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
                        onClick={() =>
                          setVisibleCount((count) => count + CONNECTION_CATALOG_PAGE_SIZE)
                        }
                      >
                        <Trans>Show more</Trans>
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  {strongMatches.length > 0 && !category ? (
                    <div className="mb-2 grid grid-cols-2 gap-2">
                      {strongMatches.map((item) =>
                        renderCatalogTile(item, item.name, item.logo, { tileTestId: true }),
                      )}
                    </div>
                  ) : null}
                  {renderPluginSections()}
                  {rendered.length > 0 && !category ? (
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {rendered.map((item) =>
                        renderCatalogTile(item, item.name, item.logo, { tileTestId: true }),
                      )}
                    </div>
                  ) : null}
                  {rendered.length < weakMatches.length && !category ? (
                    <div className="mt-4 flex justify-center">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          setVisibleCount((count) => count + CONNECTION_CATALOG_PAGE_SIZE)
                        }
                      >
                        <Trans>Show more</Trans>
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
                    className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
                  >
                    <Trans>Submit a plugin</Trans>
                    <ArrowUpRight size={14} />
                  </a>
                </div>
              ) : null}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
