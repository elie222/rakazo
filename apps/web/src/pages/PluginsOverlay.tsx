import { Trans, useLingui } from "@lingui/react/macro";
import type { CapabilityInstall, ConnectionCatalogItem } from "@rakazo/contracts";
import {
  abortableDelay,
  buildFeaturedConnectorTiles,
  CONNECTION_CATALOG_PAGE_SIZE,
  EMPTY_PLUGIN_CATALOG_MESSAGE,
  filterConnectionCatalogItems,
} from "@rakazo/core";
import {
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
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../lib/rpc";

type SourceKind = "treg" | "mcp" | "api";

function itemKey(item: Pick<ConnectionCatalogItem, "connectorId" | "slug">) {
  return `${item.connectorId}:${item.slug}`;
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
  onClose,
  onOpenMcp,
  activeBotId,
}: {
  onClose: () => void;
  onOpenMcp?: () => void;
  activeBotId?: string;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(CONNECTION_CATALOG_PAGE_SIZE);
  const [catalog, setCatalog] = useState<ConnectionCatalogItem[]>([]);
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
  const [loading, setLoading] = useState(true);
  const connectionAttempt = useRef<AbortController | null>(null);

  async function refresh() {
    const [items, installs] = await Promise.all([
      rpc.connections.catalog({}),
      rpc.capabilities.list(),
    ]);
    setCatalog(items);
    setSources(installs.filter((install) => install.kind === "mcp" || install.kind === "api"));
    return items;
  }

  useEffect(() => {
    void refresh()
      .catch((err: unknown) =>
        setCatalogError(err instanceof Error ? err.message : t`Could not load integrations`),
      )
      .finally(() => setLoading(false));
    return () => connectionAttempt.current?.abort();
  }, []);

  const featuredTiles = useMemo(() => buildFeaturedConnectorTiles(catalog), [catalog]);
  const showFeatured = !query.trim();

  const visible = useMemo(() => filterConnectionCatalogItems(catalog, query), [catalog, query]);
  const rendered = visible.slice(0, visibleCount);

  async function notifyAppConnected(item: ConnectionCatalogItem) {
    if (!activeBotId) return;
    await rpc.onboarding
      .appConnected({ botId: activeBotId, provider: item.slug })
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
    const key = itemKey(item);
    setPending(key);
    try {
      const started = await rpc.connections.begin({
        connectorId: item.connectorId,
        provider: item.slug,
        displayName: item.name,
      });
      if (started.authorizationUrl)
        window.open(started.authorizationUrl, "rakazo-plugin-connect", "noopener,noreferrer");
      if (item.noAuth && !started.authorizationUrl) {
        if (controller.signal.aborted) return;
        setItemConnected(item, true);
        void notifyAppConnected(item);
        return;
      }
      for (let i = 0; i < 45; i += 1) {
        if (controller.signal.aborted) return;
        const row = await rpc.connections
          .complete({ connectionId: started.connectionId })
          .catch(() => undefined);
        if (row?.status === "connected") {
          if (controller.signal.aborted) return;
          setItemConnected(item, true);
          void notifyAppConnected(item);
          return;
        }
        await abortableDelay(2_000, controller.signal);
      }
      if (controller.signal.aborted) return;
      setCatalogError(
        t`Connection to ${item.name} is still pending. You can close this and check again.`,
      );
    } catch (err) {
      if (controller.signal.aborted) return;
      setCatalogError(err instanceof Error ? err.message : t`Could not connect`);
    } finally {
      if (connectionAttempt.current === controller) {
        connectionAttempt.current = null;
        setPending(null);
      }
    }
  }

  async function revoke(item: ConnectionCatalogItem) {
    setCatalogError(null);
    const key = itemKey(item);
    setPending(key);
    try {
      const rows = await rpc.connections.list();
      const matches = rows.filter(
        (entry) => entry.connectorId === item.connectorId && entry.provider === item.slug,
      );
      const row =
        matches.find((entry) => entry.status === "connected") ??
        matches.find((entry) => entry.status === "pending") ??
        matches.find((entry) => entry.status === "error");
      if (!row) throw new Error(t`No connection record found for ${item.name}.`);
      await rpc.connections.revoke({ connectionId: row.id });
      setItemConnected(item, false);
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : t`Could not revoke connection`);
    } finally {
      setPending(null);
    }
  }

  function beginSource(kind: SourceKind) {
    setSourceKind(kind);
    setSourceError(null);
    setSourceName(kind === "treg" ? "Treg" : "");
    setSourceUrl(kind === "treg" ? "https://treg.to/mcp/" : "");
    setCredential("");
    setAuthType(kind === "treg" ? "bearer" : "none");
    setAuthName("x-api-key");
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
        kind: sourceKind === "api" ? "api" : "mcp",
        name: sourceName.trim() || (sourceKind === "treg" ? "Treg" : "Custom connector"),
        source: sourceUrl.trim(),
        credential: credential.trim() || undefined,
        config:
          sourceKind === "treg"
            ? { preset: "treg", auth: { type: "bearer" } }
            : sourceKind === "api"
              ? { openApi: true, auth }
              : { preset: "custom", auth },
      });
      setCredential("");
      setSourceKind(null);
      await refresh();
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : t`Could not install connector`);
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
      setSourceError(err instanceof Error ? err.message : t`Could not remove connector`);
    } finally {
      setPending(null);
    }
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

        <div className="px-8 pt-4">
          <Input
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

        <div id="integration-list" className="rk-scroll flex-1 overflow-y-auto px-8 py-6">
          {catalogError ? <p className="mb-4 text-sm text-destructive">{catalogError}</p> : null}
          {loading ? (
            <p className="text-muted-foreground/80">
              <Trans>Loading integrations…</Trans>
            </p>
          ) : null}

          {showFeatured ? (
            <div className="mb-6" data-testid="featured-connectors">
              {!loading && catalog.length === 0 ? (
                <p className="text-[13.5px] leading-6 text-muted-foreground/80">
                  {EMPTY_PLUGIN_CATALOG_MESSAGE}
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {featuredTiles.map((tile) => {
                    const item = tile.item;
                    const key = item ? itemKey(item) : tile.id;
                    const disabled = tile.missing || !item;
                    const connected = item?.connected ?? false;
                    return (
                      <div
                        key={key}
                        className={`flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2 ${
                          disabled ? "opacity-70" : ""
                        }`}
                      >
                        {item?.logo ? (
                          <img
                            src={item.logo}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            className="h-9 w-9 shrink-0 rounded-xl bg-accent object-contain"
                          />
                        ) : (
                          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-sm font-semibold text-foreground">
                            {tile.label[0]}
                          </div>
                        )}
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
                        {item && !tile.missing ? (
                          <Button
                            type="button"
                            variant="secondary"
                            className="rounded-full"
                            size="sm"
                            disabled={pending === key}
                            onClick={() => void (connected ? revoke(item) : connect(item))}
                          >
                            {pending === key ? (
                              connected ? (
                                <Trans>Removing…</Trans>
                              ) : (
                                <Trans>Adding…</Trans>
                              )
                            ) : connected ? (
                              <Trans>Remove</Trans>
                            ) : (
                              <Trans>Add</Trans>
                            )}
                          </Button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          {!loading && catalog.length === 0 && !showFeatured ? (
            <p className="text-muted-foreground/80">
              <Trans>No managed app catalog is configured on this deployment.</Trans>
            </p>
          ) : null}
          {!loading && catalog.length > 0 && visible.length === 0 && !showFeatured ? (
            <p className="text-muted-foreground/80">
              <Trans>No apps match your search.</Trans>
            </p>
          ) : null}
          {visible.length > 0 ? (
            <div className="grid grid-cols-2 gap-2">
              {rendered.map((item) => {
                const key = itemKey(item);
                return (
                  <div key={key} className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2">
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
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[15px] font-medium text-foreground">
                        {item.name}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      className="rounded-full"
                      size="sm"
                      disabled={pending === key}
                      onClick={() => void (item.connected ? revoke(item) : connect(item))}
                    >
                      {pending === key ? (
                        item.connected ? (
                          <Trans>Removing…</Trans>
                        ) : (
                          <Trans>Adding…</Trans>
                        )
                      ) : item.connected ? (
                        <Trans>Remove</Trans>
                      ) : (
                        <Trans>Add</Trans>
                      )}
                    </Button>
                  </div>
                );
              })}
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

          <details
            data-testid="integrations-advanced"
            className="group mt-8"
            onToggle={(event) => {
              if (!(event.currentTarget as HTMLDetailsElement).open) {
                setSourceKind(null);
                setSourceError(null);
                setSourceName("");
                setSourceUrl("");
                setCredential("");
                setAuthType("none");
                setAuthName("x-api-key");
              }
            }}
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[14px] text-muted-foreground">
              <span className="text-muted-foreground">
                <Trans>Advanced</Trans>
              </span>
              <span aria-hidden="true" className="transition-transform group-open:rotate-90">
                ›
              </span>
            </summary>

            <div className="mt-4 space-y-4">
              {onOpenMcp ? (
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-full"
                  size="sm"
                  onClick={onOpenMcp}
                >
                  <Trans>MCP servers</Trans>
                </Button>
              ) : null}

              <div className="flex flex-wrap gap-2">
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
                      ) : sourceKind === "mcp" ? (
                        <Trans>Add remote MCP server</Trans>
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
                            : "https://example.com/openapi.json"
                        }
                      />
                    ) : null}
                    {sourceKind !== "treg" ? (
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
                    {authType === "header" && sourceKind !== "treg" ? (
                      <Input
                        value={authName}
                        onChange={(event) => setAuthName(event.target.value)}
                        placeholder={t`Header name`}
                      />
                    ) : null}
                    {sourceKind === "treg" || authType !== "none" ? (
                      <Input
                        type="password"
                        autoComplete="new-password"
                        value={credential}
                        onChange={(event) => setCredential(event.target.value)}
                        placeholder={sourceKind === "treg" ? t`Treg token` : t`Credential`}
                      />
                    ) : null}
                    <p className="text-xs leading-5 text-muted-foreground">
                      <Trans>
                        Rakazo verifies the source before saving it. Credentials are encrypted and
                        are never returned to clients or exposed to the model.
                      </Trans>
                    </p>
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
                  <div key={source.id} className="flex items-center gap-4 rounded-xl px-3 py-2.5">
                    <div className="grid h-[42px] w-[42px] place-items-center rounded-xl bg-accent font-semibold uppercase text-foreground">
                      {source.kind === "mcp" ? "M" : "A"}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[15.5px] font-medium text-foreground">{source.name}</div>
                      <div className="truncate text-[13.5px] text-muted-foreground/70">
                        {source.kind.toUpperCase()} · {source.source} ·{" "}
                        {source.secretConfigured ? (
                          <Trans>credential saved</Trans>
                        ) : (
                          <Trans>no auth</Trans>
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
              </div>
            </div>
          </details>
        </div>
      </DialogContent>
    </Dialog>
  );
}
