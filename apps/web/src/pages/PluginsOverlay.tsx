import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type {
  CapabilityInstall,
  Connection,
  ConnectionCatalogItem,
  IntegrationCatalogResult,
  IntegrationCatalogSurface,
  McpServer,
} from "@rakazo/contracts";
import {
  buildFeaturedConnectorTiles,
  CONNECTION_CATALOG_PAGE_SIZE,
  catalogItemAccounts,
  catalogItemKey,
  connectCatalogItem,
  filterConnectionCatalogItems,
  humanizeToolName,
  isCatalogItemConnected,
} from "@rakazo/core";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Disclosure,
  Input,
  NativeSelect,
  NativeSelectOption,
  Spinner,
} from "@rakazo/ui-web";
import { ChevronLeft, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { IntegrationSetup } from "../components/integrations/IntegrationSetup";
import { connectedAppMarks } from "../lib/connected-apps";
import { optionalCatalogFeedProbe } from "../lib/optional-catalog-feed";
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

type ConnectionTool = { name: string; description: string };

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
  const [setupOpen, setSetupOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(CONNECTION_CATALOG_PAGE_SIZE);
  const [catalog, setCatalog] = useState<ConnectionCatalogItem[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [sources, setSources] = useState<CapabilityInstall[]>([]);
  const [sourceKind, setSourceKind] = useState<SourceKind | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [authType, setAuthType] = useState<"none" | "bearer" | "header">("bearer");
  const [authName, setAuthName] = useState("x-api-key");
  const [pending, setPending] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceHint, setSourceHint] = useState<string | null>(null);
  const [catalogFeedEnabled, setCatalogFeedEnabled] = useState(false);
  const [catalogFeedQuery, setCatalogFeedQuery] = useState("");
  const [catalogFeedResults, setCatalogFeedResults] = useState<IntegrationCatalogResult[]>([]);
  const [catalogFeedError, setCatalogFeedError] = useState<string | null>(null);
  const [catalogFeedPending, setCatalogFeedPending] = useState(false);
  const [catalogFeedSearched, setCatalogFeedSearched] = useState(false);
  const [loading, setLoading] = useState(true);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [detailKey, setDetailKey] = useState<{ connectorId: string; slug: string } | null>(null);
  const [tools, setTools] = useState<ConnectionTool[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsTick, setToolsTick] = useState(0);
  const connectionAttempt = useRef<AbortController | null>(null);
  const mcpRefreshGeneration = useRef(0);

  async function refreshMcp() {
    const generation = ++mcpRefreshGeneration.current;
    try {
      const servers = await rpc.mcp.servers.list();
      if (generation !== mcpRefreshGeneration.current) return;
      setMcpServers(servers);
      setMcpError(null);
    } catch (reason) {
      if (generation === mcpRefreshGeneration.current)
        setMcpError(errorText(reason, t`Could not load MCP servers`));
    }
  }

  async function refresh() {
    void refreshMcp();
    // The catalog call reconciles connection rows, so list them after it settles.
    const catalog = rpc.connections.catalog({});
    const [items, installs, rows, catalogFeed] = await Promise.all([
      catalog,
      rpc.capabilities.list(),
      catalog.catch(() => undefined).then(() => rpc.connections.list()),
      optionalCatalogFeedProbe(rpc.capabilities.catalogSearch({ query: "" })),
    ]);
    setCatalogLoaded(true);
    setCatalog(items);
    setConnections(rows);
    setLabelDrafts((current) => {
      const next: Record<string, string> = {};
      for (const row of rows) {
        if (row.status === "connected" || row.status === "pending") {
          next[row.id] = current[row.id] ?? row.displayName;
        }
      }
      return next;
    });
    setSources(
      installs.filter(
        (install) => install.kind === "mcp" || install.kind === "api" || install.kind === "graphql",
      ),
    );
    setCatalogFeedEnabled(catalogFeed.enabled);
    return items;
  }

  function load() {
    setLoading(true);
    setCatalogError(null);
    void refresh()
      .catch((err: unknown) => setCatalogError(errorText(err, t`Could not load integrations`)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    return () => {
      mcpRefreshGeneration.current += 1;
      connectionAttempt.current?.abort();
    };
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

  useEffect(() => {
    if (!detailKey) {
      setTools([]);
      setToolsLoading(false);
      return;
    }
    let cancelled = false;
    setToolsLoading(true);
    void rpc.connections
      .tools({ connectorId: detailKey.connectorId, provider: detailKey.slug })
      .then((list) => {
        if (!cancelled) setTools(list);
      })
      .catch(() => {
        if (!cancelled) setTools([]);
      })
      .finally(() => {
        if (!cancelled) setToolsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [detailKey, toolsTick]);

  const featuredTiles = useMemo(() => buildFeaturedConnectorTiles(catalog), [catalog]);
  const showFeatured = !query.trim();

  const visible = useMemo(() => filterConnectionCatalogItems(catalog, query), [catalog, query]);
  const rendered = visible.slice(0, visibleCount);

  function openDetail(item: ConnectionCatalogItem) {
    setCatalogError(null);
    setDetailKey({ connectorId: item.connectorId, slug: item.slug });
  }

  function closeDetail() {
    setDetailKey(null);
    setTools([]);
  }

  function itemConnected(item: ConnectionCatalogItem) {
    return isCatalogItemConnected(connections, item);
  }

  async function notifyAppConnected(item: ConnectionCatalogItem) {
    if (!activeBotId) return;
    await rpc.onboarding
      .appConnected({ botId: activeBotId, provider: item.slug, connectorId: item.connectorId })
      .catch(() => undefined);
  }

  function setItemConnected(item: ConnectionCatalogItem, connected: boolean) {
    setCatalog((prev) => markConnected(prev, item.connectorId, item.slug, connected));
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
        setItemConnected(item, true);
        void notifyAppConnected(item);
        await refresh().catch(() => undefined);
        setToolsTick((tick) => tick + 1);
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
        setItemConnected(item, false);
      }
      await refresh().catch(() => undefined);
      setToolsTick((tick) => tick + 1);
    } catch (err) {
      setCatalogError(errorText(err, t`Could not revoke connection`));
    } finally {
      setPending(null);
    }
  }

  async function uninstall(item: ConnectionCatalogItem) {
    const matches = catalogItemAccounts(connections, item);
    if (matches.length === 0) {
      setItemConnected(item, false);
      closeDetail();
      return;
    }
    setCatalogError(null);
    setPending(`uninstall:${catalogItemKey(item)}`);
    try {
      for (const row of matches) {
        await rpc.connections.revoke({ connectionId: row.id });
      }
      setItemConnected(item, false);
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
    if (!displayName || displayName === row.displayName) return;
    setPending(`rename:${row.id}`);
    setCatalogError(null);
    try {
      const updated = await rpc.connections.rename({ connectionId: row.id, displayName });
      setConnections((current) =>
        current.map((entry) =>
          entry.id === row.id ? { ...entry, displayName: updated.displayName } : entry,
        ),
      );
      setLabelDrafts((current) => ({ ...current, [row.id]: updated.displayName }));
    } catch (err) {
      setCatalogError(errorText(err, t`Could not rename connection`));
    } finally {
      setPending(null);
    }
  }

  function beginSource(kind: SourceKind) {
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
      const response = await rpc.capabilities.catalogSearch({ query: catalogFeedQuery });
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
      await refresh();
    } catch (err) {
      setSourceError(errorText(err, t`Could not install connector`));
    } finally {
      setPending(null);
    }
  }

  async function removeSource(install: CapabilityInstall) {
    setPending(install.id);
    setSourceError(null);
    try {
      await rpc.capabilities.remove({ id: install.id });
      setSources((current) => current.filter((source) => source.id !== install.id));
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
          className="rounded-full"
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
        className="rounded-full"
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
        className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2"
      >
        {connected ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-start hover:bg-accent/60"
            onClick={() => openDetail(item)}
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
            className="rounded-full"
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
                className="h-9 rounded-lg border-transparent bg-transparent px-2 text-[14px] shadow-none hover:bg-accent/60 focus-visible:bg-background dark:bg-transparent"
                onChange={(event) =>
                  setLabelDrafts((current) => ({ ...current, [row.id]: event.target.value }))
                }
                onBlur={() => void renameAccount(row)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
              />
              <Button
                type="button"
                variant="ghost"
                className="h-8 shrink-0 rounded-full px-2.5 text-[12px] text-muted-foreground pointer-fine:opacity-0 pointer-fine:group-focus-within/account:opacity-100 pointer-fine:group-hover/account:opacity-100"
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
            className="h-9 rounded-lg px-2 text-[14px] text-muted-foreground"
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
          <DialogTitle className="text-2xl text-foreground">
            <Trans>Integrations</Trans>
          </DialogTitle>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close integrations`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>

        {!detailItem ? (
          <div className="px-8 pt-4">
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
          {catalogError ? (
            <div className="mb-4 flex items-center gap-3">
              <p className="text-sm text-destructive">{catalogError}</p>
              {!catalogLoaded ? (
                <Button variant="outline" size="sm" onClick={load}>
                  <Trans>Retry</Trans>
                </Button>
              ) : null}
            </div>
          ) : null}

          {!detailItem && (mcpServers.length > 0 || mcpError) ? (
            <section data-testid="registered-mcp-servers" className="mb-6">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h2 className="text-sm font-medium">
                  <Trans>MCP servers</Trans>
                </h2>
                {onOpenMcp ? (
                  <Button variant="link" size="xs" onClick={onOpenMcp}>
                    <Trans>Manage MCP servers</Trans>
                  </Button>
                ) : null}
              </div>
              {mcpError ? (
                <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
                  {mcpError}
                  <Button variant="link" size="xs" onClick={() => void refreshMcp()}>
                    <Trans>Retry</Trans>
                  </Button>
                </div>
              ) : null}
              {mcpServers
                .filter((server) =>
                  `${server.name} ${server.description}`
                    .toLowerCase()
                    .includes(query.trim().toLowerCase()),
                )
                .map((server) => (
                  <div
                    key={server.id}
                    data-testid="registered-mcp-server"
                    className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2"
                  >
                    <ConnectorIcon name={server.name} />
                    <span className="min-w-0 flex-1 truncate text-[15px] font-medium">
                      {server.name}
                    </span>
                    <span className="shrink-0 text-[12.5px] text-muted-foreground">
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
                  </div>
                ))}
            </section>
          ) : null}

          {detailItem ? (
            renderDetail(detailItem)
          ) : (
            <>
              {catalogLoaded && showFeatured ? (
                <div className="mb-6" data-testid="featured-connectors">
                  {catalog.length === 0 ? (
                    <p className="text-[13.5px] leading-6 text-muted-foreground/80">
                      <Trans>Configure a plugin catalog on the server to connect apps.</Trans>
                    </p>
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

              {catalogLoaded && catalog.length === 0 && !showFeatured ? (
                <p className="text-muted-foreground/80">
                  <Trans>No managed app catalog is configured on this deployment.</Trans>
                </p>
              ) : null}
              {catalogLoaded && catalog.length > 0 && visible.length === 0 && !showFeatured ? (
                <p className="text-muted-foreground/80">
                  <Trans>No apps match your search.</Trans>
                </p>
              ) : null}
              {visible.length > 0 ? (
                <div className="grid grid-cols-2 gap-2">
                  {rendered.map((item) =>
                    renderCatalogTile(item, item.name, item.logo, {
                      // Avoid duplicate connection-tile-* ids while featured is also shown.
                      tileTestId: !showFeatured,
                    }),
                  )}
                </div>
              ) : null}
              {rendered.length < visible.length ? (
                <div className="mt-4 flex justify-center">
                  <Button
                    type="button"
                    variant="secondary"
                    className="rounded-full"
                    size="sm"
                    onClick={() => setVisibleCount((count) => count + CONNECTION_CATALOG_PAGE_SIZE)}
                  >
                    <Trans>Show more</Trans>
                  </Button>
                </div>
              ) : null}

              <Disclosure
                data-testid="integrations-advanced"
                className="group mt-8"
                onOpenChange={(open) => {
                  if (!open) {
                    setSourceKind(null);
                    setSetupOpen(false);
                    setSourceError(null);
                    setSourceHint(null);
                    setSourceName("");
                    setSourceUrl("");
                    setCredential("");
                    setAuthType("none");
                    setAuthName("x-api-key");
                  }
                }}
                summary={<Trans>Advanced</Trans>}
                summaryClassName="w-full flex items-center justify-between gap-3 text-[14px] text-muted-foreground"
              >
                <div className="mt-4 space-y-4">
                  {catalogFeedEnabled ? (
                    <Card data-testid="integrations-catalog-feed">
                      <CardHeader>
                        <CardTitle>
                          <Trans>Search by domain</Trans>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
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
                            className="rounded-full"
                            size="sm"
                            disabled={!catalogFeedQuery.trim() || catalogFeedPending}
                          >
                            {catalogFeedPending ? <Trans>Searching…</Trans> : <Trans>Search</Trans>}
                          </Button>
                        </form>
                        {catalogFeedError ? (
                          <p className="text-sm text-destructive">{catalogFeedError}</p>
                        ) : null}
                        {catalogFeedSearched &&
                        !catalogFeedPending &&
                        catalogFeedResults.length === 0 ? (
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
                              <p className="mt-2 text-sm leading-5 text-muted-foreground">
                                {result.description}
                              </p>
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
                                    className="rounded-full"
                                    size="sm"
                                    disabled={!canAdd}
                                    title={canAdd ? undefined : t`Manual setup required`}
                                    onClick={() => beginCatalogSurface(result, surface)}
                                  >
                                    {surface.kind.toUpperCase()} · {canAdd ? t`Add` : t`Manual`}
                                  </Button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  ) : null}

                  <Button
                    type="button"
                    variant="secondary"
                    className="rounded-full"
                    size="sm"
                    aria-expanded={setupOpen}
                    onClick={() => setSetupOpen((current) => !current)}
                  >
                    <Trans>Browse MCP servers</Trans>
                  </Button>
                  {setupOpen ? (
                    <IntegrationSetup
                      botId={activeBotId}
                      onDone={() => {
                        setSetupOpen(false);
                        void refresh().catch((err: unknown) =>
                          setCatalogError(errorText(err, t`Could not load integrations`)),
                        );
                      }}
                    />
                  ) : null}

                  <div data-testid="integrations-advanced-add" className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      className="rounded-full"
                      size="sm"
                      onClick={() => beginSource("mcp")}
                    >
                      <Trans>Add MCP server</Trans>
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      className="rounded-full"
                      size="sm"
                      onClick={() => beginSource("api")}
                    >
                      <Trans>Add OpenAPI</Trans>
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      className="rounded-full"
                      size="sm"
                      onClick={() => beginSource("graphql")}
                    >
                      <Trans>Add GraphQL</Trans>
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      className="rounded-full"
                      size="sm"
                      onClick={() => beginSource("executor")}
                    >
                      <Trans>Add Executor</Trans>
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      className="rounded-full"
                      size="sm"
                      onClick={() => beginSource("treg")}
                    >
                      <Trans>Add Treg</Trans>
                    </Button>
                  </div>

                  {sourceError ? <p className="text-sm text-destructive">{sourceError}</p> : null}

                  {sourceKind ? (
                    <Card>
                      <CardHeader>
                        <CardTitle>
                          {sourceKind === "treg" ? (
                            <Trans>Connect Treg</Trans>
                          ) : sourceKind === "executor" ? (
                            <Trans>Connect Executor</Trans>
                          ) : sourceKind === "mcp" ? (
                            <Trans>Add remote MCP server</Trans>
                          ) : sourceKind === "graphql" ? (
                            <Trans>Add GraphQL endpoint</Trans>
                          ) : (
                            <Trans>Import OpenAPI JSON</Trans>
                          )}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <Input
                          value={sourceName}
                          onChange={(event) => setSourceName(event.target.value)}
                          placeholder={t`Display name`}
                        />
                        {sourceKind !== "treg" ? (
                          <Input
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
                        ) : null}
                        {sourceKind !== "treg" && sourceKind !== "executor" ? (
                          <NativeSelect
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
                        ) : null}
                        {authType === "header" &&
                        sourceKind !== "treg" &&
                        sourceKind !== "executor" ? (
                          <Input
                            value={authName}
                            onChange={(event) => setAuthName(event.target.value)}
                            placeholder={t`Header name`}
                          />
                        ) : null}
                        {sourceKind === "treg" ||
                        sourceKind === "executor" ||
                        authType !== "none" ? (
                          <Input
                            type="password"
                            autoComplete="new-password"
                            value={credential}
                            onChange={(event) => setCredential(event.target.value)}
                            placeholder={
                              sourceKind === "treg"
                                ? t`Treg token`
                                : sourceKind === "executor"
                                  ? t`Executor token`
                                  : t`Credential`
                            }
                          />
                        ) : null}
                        <p className="text-xs leading-5 text-muted-foreground">
                          <Trans>Credentials are encrypted and never sent to the model.</Trans>
                        </p>
                        {sourceHint ? (
                          <p className="text-xs leading-5 text-muted-foreground">{sourceHint}</p>
                        ) : null}
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            variant="secondary"
                            className="rounded-full"
                            size="sm"
                            disabled={pending === "install-source"}
                            onClick={() => void installSource()}
                          >
                            {pending === "install-source" ? (
                              <Trans>Verifying…</Trans>
                            ) : (
                              <Trans>Verify and add</Trans>
                            )}
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            className="rounded-full"
                            size="sm"
                            onClick={() => setSourceKind(null)}
                          >
                            <Trans>Cancel</Trans>
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ) : null}

                  <div>
                    <div className="mb-3 text-sm font-medium text-foreground/75">
                      <Trans>Tool sources</Trans>
                    </div>
                    {sources.length === 0 && !sourceKind ? (
                      <p className="text-muted-foreground/80">
                        <Trans>No MCP or API tool sources installed yet.</Trans>
                      </p>
                    ) : null}
                    {sources.map((source) => (
                      <div
                        key={source.id}
                        className="flex items-center gap-4 rounded-xl px-3 py-2.5"
                      >
                        <div className="grid h-[42px] w-[42px] place-items-center rounded-xl bg-accent font-semibold uppercase text-foreground">
                          {source.kind === "mcp" ? "M" : source.kind === "graphql" ? "G" : "A"}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-[15.5px] font-medium text-foreground">
                            {source.name}
                          </div>
                          <div className="truncate text-[13.5px] text-muted-foreground/70">
                            {source.kind.toUpperCase()} · {source.source} ·{" "}
                            {source.secretConfigured ? (
                              <Trans>Credential saved</Trans>
                            ) : (
                              <Trans>No auth</Trans>
                            )}
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="secondary"
                          className="rounded-full"
                          size="sm"
                          disabled={pending === source.id}
                          onClick={() => void removeSource(source)}
                        >
                          {pending === source.id ? <Trans>Removing…</Trans> : <Trans>Remove</Trans>}
                        </Button>
                      </div>
                    ))}
                    {onOpenMcp && mcpServers.length === 0 && !mcpError ? (
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        className="mt-2 px-0 text-muted-foreground"
                        onClick={onOpenMcp}
                      >
                        <Trans>Manage MCP servers</Trans>
                      </Button>
                    ) : null}
                  </div>
                </div>
              </Disclosure>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
