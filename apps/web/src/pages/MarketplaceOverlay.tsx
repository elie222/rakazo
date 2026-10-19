import { Trans, useLingui } from "@lingui/react/macro";
import type {
  CapabilityInstall,
  McpServer,
  PluginMarketplaceCatalog,
  PluginMarketplaceEntry,
  PluginPreview,
} from "@rakazo/contracts";
import { PluginPreviewSchema } from "@rakazo/contracts";
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
} from "@rakazo/ui-web";
import { ArrowLeft, Store, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { connectMcpOauth } from "../lib/mcp-connect";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

type Selection = Pick<PluginMarketplaceEntry, "source" | "installedSource" | "name">;
export function MarketplaceOverlay({
  onClose,
  activeBotId,
  initialTab = "discover",
}: {
  onClose: () => void;
  activeBotId?: string;
  initialTab?: "discover" | "installed";
}) {
  const { t } = useLingui();
  const [tab, setTab] = useState<"discover" | "installed">(initialTab);
  const [query, setQuery] = useState("");
  const [manualSource, setManualSource] = useState("");
  const [catalog, setCatalog] = useState<PluginMarketplaceCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [visible, setVisible] = useState(24);
  const [installs, setInstalls] = useState<CapabilityInstall[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [assigned, setAssigned] = useState(new Set<string>());
  const [selected, setSelected] = useState<Selection | null>(null);
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [noAuth, setNoAuth] = useState(new Set<string>());
  const generation = useRef(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current++;
    };
  }, []);

  async function refresh() {
    const [rows, mcp, assignments] = await Promise.all([
      rpc.capabilities.list(),
      rpc.mcp.servers.list(),
      activeBotId ? rpc.mcp.assignments.list({ botId: activeBotId }) : Promise.resolve([]),
    ]);
    if (!live.current) return;
    setInstalls(rows.filter((row) => row.kind === "plugin"));
    setServers(mcp);
    setAssigned(new Set(assignments.map((row) => row.serverId)));
  }
  useEffect(() => {
    void refresh().catch((err) => {
      if (live.current) setError(errorText(err, t`Could not load installed plugins`));
    });
  }, [activeBotId]);
  useEffect(() => {
    let cancelled = false;
    setCatalogLoading(true);
    const timer = window.setTimeout(() => {
      void rpc.marketplace
        .catalog({ query })
        .then((result) => {
          if (!cancelled) {
            setCatalog(result);
            setCatalogError(null);
            setVisible(24);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setCatalog(null);
            setCatalogError(errorText(err, t`Could not load marketplace`));
          }
        })
        .finally(() => {
          if (!cancelled) setCatalogLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, retry]);

  const installed = selected
    ? installs.find((row) => row.source === selected.installedSource)
    : undefined;
  const parsed = installed ? PluginPreviewSchema.safeParse(installed.config) : null;
  const detail = installed && parsed?.success ? parsed.data : preview;
  const children = installed ? servers.filter((server) => server.installId === installed.id) : [];

  function back() {
    generation.current++;
    setSelected(null);
    setPreview(null);
    setError(null);
    setPreviewLoading(false);
    setConfirmRemove(false);
  }
  async function select(selection: Selection) {
    const token = ++generation.current;
    setSelected(selection);
    setPreview(null);
    setError(null);
    setConfirmRemove(false);
    if (installs.some((row) => row.source === selection.installedSource)) {
      setPreviewLoading(false);
      return;
    }
    setPreviewLoading(true);
    try {
      const result = await rpc.capabilities.pluginPreview({ source: selection.source });
      if (live.current && generation.current === token) setPreview(result);
    } catch (err) {
      if (live.current && generation.current === token)
        setError(errorText(err, t`Could not preview plugin`));
    } finally {
      if (live.current && generation.current === token) setPreviewLoading(false);
    }
  }
  async function add() {
    if (!selected || !preview || pending) return;
    setPending("install");
    setError(null);
    try {
      const row = await rpc.capabilities.install({
        kind: "plugin",
        name: preview.name,
        source: preview.pinnedSource ?? selected.source,
        pluginDigest: preview.digest,
        config: {},
      });
      if (!live.current) return;
      // Keep the successful install visible even if the subsequent read fails.
      setInstalls((current) => [...current.filter((item) => item.id !== row.id), row]);
      setSelected((current) => (current ? { ...current, installedSource: row.source } : null));
      try {
        await refresh();
      } catch (err) {
        if (live.current)
          setError(errorText(err, t`Plugin installed. Could not load connection status.`));
      }
    } catch (err) {
      if (live.current) setError(errorText(err, t`Could not install plugin`));
    } finally {
      if (live.current) setPending(null);
    }
  }
  async function connect(server: McpServer) {
    setPending(server.id);
    setError(null);
    try {
      const result = await connectMcpOauth(server.id, { returnToMarketplace: true });
      if (!live.current) return;
      if (result === "authorization_not_requested")
        setNoAuth((current) => new Set([...current, server.id]));
      if (result === "cancelled" && live.current) setError(t`Sign-in cancelled. Try again.`);
      await refresh();
    } catch (err) {
      if (live.current) setError(errorText(err, t`Could not sign in`));
    } finally {
      if (live.current) setPending(null);
    }
  }
  async function enable(server: McpServer) {
    if (!activeBotId) return;
    setPending(server.id);
    setError(null);
    try {
      await rpc.mcp.assignments.approve({ botId: activeBotId, serverId: server.id });
      await refresh();
    } catch (err) {
      if (live.current) setError(errorText(err, t`Could not enable tools`));
    } finally {
      if (live.current) setPending(null);
    }
  }
  async function remove() {
    if (!installed) return;
    setPending("remove");
    setError(null);
    try {
      await rpc.capabilities.remove({ id: installed.id });
      if (!live.current) return;
      setInstalls((current) => current.filter((row) => row.id !== installed.id));
      back();
      try {
        await refresh();
      } catch (err) {
        if (live.current) setError(errorText(err, t`Could not refresh installed plugins`));
      }
    } catch (err) {
      if (live.current) setError(errorText(err, t`Could not remove plugin`));
    } finally {
      if (live.current) setPending(null);
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
        className="flex h-[min(760px,90dvh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
        showCloseButton={false}
      >
        <DialogHeader className="flex-row items-center justify-between border-b px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <Store size={18} />
            <Trans>Marketplace</Trans>
          </DialogTitle>
          <DialogClose
            render={<Button variant="ghost" size="icon" aria-label={t`Close marketplace`} />}
          >
            <X size={18} />
          </DialogClose>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {error ? (
            <p role="alert" className="mb-4 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {selected ? (
            <>
              <Button variant="ghost" size="sm" onClick={back} disabled={Boolean(pending)}>
                <ArrowLeft size={14} />
                <Trans>Back</Trans>
              </Button>
              {error && !installed && !previewLoading ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={Boolean(pending)}
                  onClick={() => void select(selected)}
                >
                  <Trans>Retry preview</Trans>
                </Button>
              ) : null}
              <div className="mt-4 flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-xl font-semibold">{detail?.name ?? selected.name}</h2>
                  <p className="mt-2 text-sm text-muted-foreground">{detail?.description}</p>
                </div>
                {installed ? (
                  <Badge>
                    <Trans>Installed</Trans>
                  </Badge>
                ) : null}
              </div>
              {previewLoading ? (
                <p role="status" className="mt-6 text-sm text-muted-foreground">
                  <Trans>Loading preview…</Trans>
                </p>
              ) : null}
              {detail ? (
                <>
                  <p className="mt-3 break-all text-xs text-muted-foreground">
                    {selected.installedSource}
                  </p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {detail.resolvedSha.slice(0, 12)}
                  </p>
                  {detail.skills.length ? (
                    <section className="mt-6">
                      <h3 className="font-medium">
                        <Trans>Skills</Trans>
                      </h3>
                      <ul className="mt-2 space-y-3">
                        {detail.skills.map((skill) => (
                          <li key={skill.name}>
                            <p className="text-sm font-medium">{skill.name}</p>
                            <p className="text-sm text-muted-foreground">{skill.description}</p>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                  {!installed && detail.mcpServers.length ? (
                    <section className="mt-6">
                      <h3 className="font-medium">
                        <Trans>MCP servers</Trans>
                      </h3>
                      <ul className="mt-2 space-y-3">
                        {detail.mcpServers.map((server) => (
                          <li key={server.name}>
                            <p className="text-sm font-medium">{server.name}</p>
                            <p className="break-all text-xs text-muted-foreground">
                              {server.endpoint}
                            </p>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                  {detail.skipped.length ? (
                    <details className="mt-6 text-sm">
                      <summary className="cursor-pointer text-muted-foreground">
                        <Trans>Skipped components</Trans> ({detail.skipped.length})
                      </summary>
                      <ul className="mt-2 space-y-2">
                        {detail.skipped.map((entry, i) => (
                          <li key={`${entry.kind}:${entry.name}:${i}`}>
                            <span className="font-medium">{entry.name}</span>: {entry.reason}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </>
              ) : null}
              {!installed && preview ? (
                <div className="mt-8 border-t pt-4">
                  <p className="mb-4 text-sm text-muted-foreground">
                    <Trans>
                      Skills apply to all your bots. MCP tools require separate approval.
                    </Trans>
                  </p>
                  <Button
                    onClick={() => void add()}
                    disabled={
                      Boolean(pending) || (!preview.skills.length && !preview.mcpServers.length)
                    }
                  >
                    {pending === "install" ? <Trans>Adding…</Trans> : <Trans>Add plugin</Trans>}
                  </Button>
                </div>
              ) : null}
              {installed ? (
                <>
                  {children.length ? (
                    <section className="mt-6 space-y-3">
                      <h3 className="font-medium">
                        <Trans>Connect</Trans>
                      </h3>
                      {children.map((server) => (
                        <section
                          aria-label={server.name}
                          key={server.id}
                          className="rounded-lg border p-4"
                        >
                          <p className="text-sm font-medium">{server.name}</p>
                          <p className="mt-1 break-all text-xs text-muted-foreground">
                            {server.endpoint}
                          </p>
                          <div className="mt-3 flex flex-wrap items-center gap-3">
                            {server.oauthStatus === "connected" ? (
                              <Badge>
                                <Trans>Connected</Trans>
                              </Badge>
                            ) : noAuth.has(server.id) ? (
                              <span className="text-sm text-muted-foreground">
                                <Trans>No sign-in required</Trans>
                              </span>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={Boolean(pending)}
                                onClick={() => void connect(server)}
                              >
                                {server.oauthStatus === "reconnect" ? (
                                  <Trans>Reconnect</Trans>
                                ) : (
                                  <Trans>Sign in</Trans>
                                )}
                              </Button>
                            )}
                            {activeBotId ? (
                              assigned.has(server.id) ? (
                                <span className="text-sm text-muted-foreground">
                                  <Trans>Enabled for this bot</Trans>
                                </span>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={Boolean(pending)}
                                  onClick={() => void enable(server)}
                                >
                                  <Trans>Use in this bot</Trans>
                                </Button>
                              )
                            ) : null}
                            {pending === server.id ? (
                              <span role="status" className="text-sm text-muted-foreground">
                                <Trans>Connecting…</Trans>
                              </span>
                            ) : null}
                          </div>
                        </section>
                      ))}
                    </section>
                  ) : null}
                  <div className="mt-8 flex gap-2 border-t pt-4">
                    <Button
                      variant="outline"
                      disabled={Boolean(pending)}
                      onClick={() => (confirmRemove ? void remove() : setConfirmRemove(true))}
                    >
                      {confirmRemove ? (
                        <Trans>Confirm removal</Trans>
                      ) : (
                        <Trans>Remove plugin</Trans>
                      )}
                    </Button>
                    {confirmRemove ? (
                      <Button
                        variant="ghost"
                        onClick={() => setConfirmRemove(false)}
                        disabled={Boolean(pending)}
                      >
                        <Trans>Cancel</Trans>
                      </Button>
                    ) : null}
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <>
              <div className="mb-5 flex gap-2">
                <Button
                  variant={tab === "discover" ? "secondary" : "ghost"}
                  onClick={() => setTab("discover")}
                >
                  <Trans>Discover</Trans>
                </Button>
                <Button
                  variant={tab === "installed" ? "secondary" : "ghost"}
                  onClick={() => setTab("installed")}
                >
                  <Trans>Installed</Trans>
                </Button>
              </div>
              {tab === "discover" ? (
                <>
                  <Input
                    aria-label={t`Search plugins`}
                    placeholder={t`Search plugins`}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    maxLength={200}
                  />
                  {catalogLoading ? (
                    <p role="status" className="mt-4 text-sm text-muted-foreground">
                      <Trans>Loading marketplace…</Trans>
                    </p>
                  ) : null}
                  {catalogError || catalog?.unavailableRegistries.length ? (
                    <div role="alert" className="mt-4 text-sm text-muted-foreground">
                      <p>{catalogError ?? t`Some registries are unavailable`}</p>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setRetry((value) => value + 1)}
                      >
                        <Trans>Retry</Trans>
                      </Button>
                    </div>
                  ) : null}
                  <div className="mt-5 grid gap-3 sm:grid-cols-2">
                    {!catalogLoading
                      ? catalog?.entries.slice(0, visible).map((entry) => (
                          <button
                            type="button"
                            key={entry.id}
                            onClick={() => void select(entry)}
                            className="rounded-xl border p-4 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <h2 className="font-medium">{entry.name}</h2>
                              <span className="text-xs text-muted-foreground">
                                {installs.some((row) => row.source === entry.installedSource) ? (
                                  <Trans>Installed</Trans>
                                ) : (
                                  entry.registry
                                )}
                              </span>
                            </div>
                            <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">
                              {entry.description}
                            </p>
                          </button>
                        ))
                      : null}
                  </div>
                  {!catalogLoading &&
                  catalog &&
                  !catalog.entries.length &&
                  !catalog.unavailableRegistries.length ? (
                    <p className="mt-4 text-sm text-muted-foreground">
                      <Trans>No plugins found</Trans>
                    </p>
                  ) : null}
                  {catalog && visible < catalog.entries.length ? (
                    <Button
                      className="mt-4"
                      variant="ghost"
                      onClick={() => setVisible((value) => value + 24)}
                    >
                      <Trans>Show more</Trans>
                    </Button>
                  ) : null}
                  <details className="mt-8 border-t pt-4">
                    <summary className="cursor-pointer text-sm text-muted-foreground">
                      <Trans>Install from GitHub</Trans>
                    </summary>
                    <form
                      className="mt-3 flex gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void select({
                          source: manualSource.trim(),
                          installedSource: manualSource.trim(),
                          name: manualSource.trim(),
                        });
                      }}
                    >
                      <Input
                        aria-label={t`Plugin GitHub URL`}
                        value={manualSource}
                        onChange={(event) => setManualSource(event.target.value)}
                        placeholder="https://github.com/owner/plugin"
                        maxLength={2048}
                        required
                      />
                      <Button type="submit" variant="outline">
                        <Trans>Preview</Trans>
                      </Button>
                    </form>
                  </details>
                </>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {installs.map((row) => (
                    <button
                      type="button"
                      key={row.id}
                      onClick={() =>
                        void select({
                          source: row.source,
                          installedSource: row.source,
                          name: row.name,
                        })
                      }
                      className="rounded-xl border p-4 text-left hover:bg-accent"
                    >
                      <h2 className="font-medium">{row.name}</h2>
                      <p className="mt-2 break-all text-xs text-muted-foreground">{row.source}</p>
                    </button>
                  ))}
                  {!installs.length ? (
                    <p className="text-sm text-muted-foreground">
                      <Trans>No plugins installed</Trans>
                    </p>
                  ) : null}
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
