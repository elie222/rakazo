import { Trans, useLingui } from "@lingui/react/macro";
import type { CapabilityInstall, ConnectionCatalogItem } from "@rakazo/contracts";
import { abortableDelay } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../lib/rpc";

type CatalogView = "all" | "connected" | "sources";
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
}: {
  onClose: () => void;
  onOpenMcp?: () => void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<CatalogView>("all");
  const [catalog, setCatalog] = useState<ConnectionCatalogItem[]>([]);
  const [sources, setSources] = useState<CapabilityInstall[]>([]);
  const [sourceKind, setSourceKind] = useState<SourceKind | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [authType, setAuthType] = useState<"none" | "bearer" | "header">("bearer");
  const [authName, setAuthName] = useState("x-api-key");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
        setError(err instanceof Error ? err.message : t`Could not load integrations`),
      )
      .finally(() => setLoading(false));
    return () => connectionAttempt.current?.abort();
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const scoped = view === "connected" ? catalog.filter((item) => item.connected) : catalog;
    if (!needle) return scoped;
    return scoped.filter(
      (item) =>
        item.name.toLowerCase().includes(needle) ||
        item.slug.toLowerCase().includes(needle) ||
        item.connectorId.toLowerCase().includes(needle),
    );
  }, [catalog, query, view]);

  function setItemConnected(item: ConnectionCatalogItem, connected: boolean) {
    setCatalog((prev) => markConnected(prev, item.connectorId, item.slug, connected));
  }

  async function connect(item: ConnectionCatalogItem) {
    connectionAttempt.current?.abort();
    const controller = new AbortController();
    connectionAttempt.current = controller;
    setError(null);
    const key = itemKey(item);
    setPending(key);
    try {
      const started = await rpc.connections.begin({
        connectorId: item.connectorId,
        provider: item.slug,
        displayName: item.name,
      });
      if (started.authorizationUrl)
        window.open(started.authorizationUrl, "_blank", "noopener,noreferrer");
      if (item.noAuth && !started.authorizationUrl) {
        if (controller.signal.aborted) return;
        setItemConnected(item, true);
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
          return;
        }
        await abortableDelay(2_000, controller.signal);
      }
      if (controller.signal.aborted) return;
      setError(t`Connection to ${item.name} is still pending. You can close this and check again.`);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : t`Could not connect`);
    } finally {
      if (connectionAttempt.current === controller) {
        connectionAttempt.current = null;
        setPending(null);
      }
    }
  }

  async function revoke(item: ConnectionCatalogItem) {
    setError(null);
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
      setError(err instanceof Error ? err.message : t`Could not revoke connection`);
    } finally {
      setPending(null);
    }
  }

  function beginSource(kind: SourceKind) {
    setSourceKind(kind);
    setView("sources");
    setError(null);
    setSourceName(kind === "treg" ? "Treg" : "");
    setSourceUrl(kind === "treg" ? "https://treg.to/mcp/" : "");
    setCredential("");
    setAuthType(kind === "treg" ? "bearer" : "none");
    setAuthName("x-api-key");
  }

  async function installSource() {
    if (!sourceKind) return;
    setError(null);
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
      setError(err instanceof Error ? err.message : t`Could not install connector`);
    } finally {
      setPending(null);
    }
  }

  async function removeSource(install: CapabilityInstall) {
    setPending(install.id);
    setError(null);
    try {
      await rpc.capabilities.remove({ id: install.id });
      setSources((current) => current.filter((source) => source.id !== install.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not remove connector`);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-[rgba(4,4,5,.62)] p-10">
      <div className="flex h-[760px] w-[1080px] max-w-full flex-col overflow-hidden rounded-[26px] border border-[#232326] bg-[#141416] shadow-[0_40px_90px_rgba(0,0,0,.55)]">
        <div className="flex items-start justify-between px-8 pt-7">
          <div>
            <div className="text-2xl font-medium text-[#F1F1F2]">
              <Trans>Integrations</Trans>
            </div>
            <p className="mt-1 text-[13.5px] text-[#7A7A80]">
              <Trans>Connect apps or add Treg, MCP, and OpenAPI tool sources.</Trans>
            </p>
          </div>
          <div className="flex items-center gap-3">
            {onOpenMcp ? (
              <button
                type="button"
                onClick={onOpenMcp}
                className="rounded-full border border-[#383844] px-3 py-1.5 text-xs text-[#C9C9CE] hover:bg-[#232327]"
              >
                <Trans>MCP servers</Trans>
              </button>
            ) : null}
            <button
              type="button"
              aria-label={t`Close integrations`}
              onClick={onClose}
              className="text-[#85858A]"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 px-8 pt-4">
          <Button type="button" variant="pill" size="sm" onClick={() => beginSource("treg")}>
            <Trans>Add Treg</Trans>
          </Button>
          <Button type="button" variant="pill" size="sm" onClick={() => beginSource("mcp")}>
            <Trans>Add MCP server</Trans>
          </Button>
          <Button type="button" variant="pill" size="sm" onClick={() => beginSource("api")}>
            <Trans>Add OpenAPI</Trans>
          </Button>
        </div>

        {view !== "sources" ? (
          <div className="px-8 pt-4">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t`Search apps`}
              className="w-full rounded-[13px] border border-[#26262A] bg-[#101012] px-4 py-3 text-[15px] text-[#ECECEE] outline-none"
            />
          </div>
        ) : null}

        <div role="tablist" aria-label={t`Integration views`} className="flex gap-1 px-8 pt-4">
          {(["all", "connected", "sources"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={view === option}
              aria-controls="integration-list"
              onClick={() => {
                setView(option);
                if (option !== "sources") setSourceKind(null);
              }}
              className={`rounded-full px-3.5 py-1.5 text-sm transition-colors ${
                view === option
                  ? "bg-[#2C2C30] text-[#F1F1F2]"
                  : "text-[#7A7A80] hover:text-[#C8C8CC]"
              }`}
            >
              {option === "all" ? (
                <Trans>Apps</Trans>
              ) : option === "connected" ? (
                <Trans>Connected</Trans>
              ) : (
                <Trans>Tool sources</Trans>
              )}
            </button>
          ))}
        </div>

        <div
          id="integration-list"
          role="tabpanel"
          className="rk-scroll flex-1 overflow-y-auto px-8 py-6"
        >
          {error ? <p className="mb-4 text-sm text-[#C94244]">{error}</p> : null}
          {loading ? (
            <p className="text-[#6C6C70]">
              <Trans>Loading integrations…</Trans>
            </p>
          ) : null}

          {view === "sources" ? (
            <div className="space-y-4">
              {sourceKind ? (
                <div className="space-y-3 rounded-[16px] border border-[#2C2C30] bg-[#101012] p-5">
                  <div className="text-base font-medium text-[#ECECEE]">
                    {sourceKind === "treg" ? (
                      <Trans>Connect Treg</Trans>
                    ) : sourceKind === "mcp" ? (
                      <Trans>Add remote MCP server</Trans>
                    ) : (
                      <Trans>Import OpenAPI JSON</Trans>
                    )}
                  </div>
                  <input
                    value={sourceName}
                    onChange={(event) => setSourceName(event.target.value)}
                    placeholder={t`Display name`}
                    className="w-full rounded-xl border border-[#2C2C30] bg-[#171719] px-3 py-2.5 text-sm text-[#ECECEE] outline-none"
                  />
                  {sourceKind !== "treg" ? (
                    <input
                      value={sourceUrl}
                      onChange={(event) => setSourceUrl(event.target.value)}
                      placeholder={
                        sourceKind === "mcp"
                          ? "https://example.com/mcp"
                          : "https://example.com/openapi.json"
                      }
                      className="w-full rounded-xl border border-[#2C2C30] bg-[#171719] px-3 py-2.5 text-sm text-[#ECECEE] outline-none"
                    />
                  ) : null}
                  {sourceKind !== "treg" ? (
                    <select
                      value={authType}
                      onChange={(event) => setAuthType(event.target.value as typeof authType)}
                      className="w-full rounded-xl border border-[#2C2C30] bg-[#171719] px-3 py-2.5 text-sm text-[#ECECEE] outline-none"
                    >
                      <option value="none">
                        <Trans>No authentication</Trans>
                      </option>
                      <option value="bearer">
                        <Trans>Bearer token</Trans>
                      </option>
                      <option value="header">
                        <Trans>API key header</Trans>
                      </option>
                    </select>
                  ) : null}
                  {authType === "header" && sourceKind !== "treg" ? (
                    <input
                      value={authName}
                      onChange={(event) => setAuthName(event.target.value)}
                      placeholder={t`Header name`}
                      className="w-full rounded-xl border border-[#2C2C30] bg-[#171719] px-3 py-2.5 text-sm text-[#ECECEE] outline-none"
                    />
                  ) : null}
                  {sourceKind === "treg" || authType !== "none" ? (
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={credential}
                      onChange={(event) => setCredential(event.target.value)}
                      placeholder={sourceKind === "treg" ? t`Treg token` : t`Credential`}
                      className="w-full rounded-xl border border-[#2C2C30] bg-[#171719] px-3 py-2.5 text-sm text-[#ECECEE] outline-none"
                    />
                  ) : null}
                  <p className="text-xs leading-5 text-[#707077]">
                    <Trans>
                      Rakazo verifies the source before saving it. Credentials are encrypted and
                      are never returned to clients or exposed to the model.
                    </Trans>
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="pill"
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
                      variant="pill"
                      size="sm"
                      onClick={() => setSourceKind(null)}
                    >
                      <Trans>Cancel</Trans>
                    </Button>
                  </div>
                </div>
              ) : null}

              {sources.length === 0 && !sourceKind ? (
                <p className="text-[#6C6C70]">
                  <Trans>No MCP or API tool sources installed yet.</Trans>
                </p>
              ) : null}
              {sources.map((source) => (
                <div key={source.id} className="flex items-center gap-4 rounded-[13px] px-3 py-2.5">
                  <div className="grid h-[42px] w-[42px] place-items-center rounded-xl bg-[#2C2C30] font-semibold uppercase text-[#ECECEE]">
                    {source.kind === "mcp" ? "M" : "A"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[15.5px] font-medium text-[#ECECEE]">{source.name}</div>
                    <div className="truncate text-[13.5px] text-[#7A7A80]">
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
                    variant="pill"
                    size="sm"
                    disabled={pending === source.id}
                    onClick={() => void removeSource(source)}
                  >
                    {pending === source.id ? <Trans>Removing…</Trans> : <Trans>Remove</Trans>}
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <>
              {!loading && catalog.length === 0 ? (
                <p className="text-[#6C6C70]">
                  <Trans>
                    No managed app catalog is configured on this deployment. You can still add
                    Treg, MCP, or OpenAPI sources.
                  </Trans>
                </p>
              ) : null}
              {!loading && catalog.length > 0 && visible.length === 0 ? (
                <p className="text-[#6C6C70]">
                  {query.trim() ? (
                    <Trans>No apps match your search.</Trans>
                  ) : (
                    <Trans>No connected apps yet.</Trans>
                  )}
                </p>
              ) : null}
              {visible.map((item) => {
                const key = itemKey(item);
                return (
                  <div key={key} className="flex items-center gap-4 rounded-[13px] px-3 py-2.5">
                    {item.logo ? (
                      <img
                        src={item.logo}
                        alt=""
                        className="h-[42px] w-[42px] rounded-xl bg-[#2C2C30] object-contain"
                      />
                    ) : (
                      <div className="grid h-[42px] w-[42px] place-items-center rounded-xl bg-[#2C2C30] font-semibold">
                        {item.name[0]}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-[15.5px] font-medium text-[#ECECEE]">{item.name}</div>
                      <div className="text-[13.5px] text-[#7A7A80]">
                        {item.connectorId} · {item.slug}
                        {item.noAuth ? (
                          <>
                            {" "}
                            · <Trans>no auth</Trans>
                          </>
                        ) : (
                          ""
                        )}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="pill"
                      size="sm"
                      disabled={pending === key}
                      onClick={() => void (item.connected ? revoke(item) : connect(item))}
                    >
                      {pending === key ? (
                        item.connected ? (
                          <Trans>Revoking…</Trans>
                        ) : (
                          <Trans>Connecting…</Trans>
                        )
                      ) : item.connected ? (
                        <Trans>Revoke</Trans>
                      ) : (
                        <Trans>Connect</Trans>
                      )}
                    </Button>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
