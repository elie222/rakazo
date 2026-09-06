import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, BotMcpServer, McpServer, McpTransport } from "@rakazo/contracts";
import { deriveMcpSlug } from "@rakazo/core";
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
  Field,
  FieldGroup,
  FieldLabel,
  FieldTitle,
  Input,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@rakazo/ui-web";
import { Check, X } from "lucide-react";
import { useEffect, useState } from "react";
import { connectMcpOauth, MCP_OAUTH_CHANNEL } from "../lib/mcp-connect";
import { rpc } from "../lib/rpc";

function oauthStatusText(server: McpServer): string | null {
  if (server.oauthStatus === "connected") return t`OAuth connected`;
  if (server.oauthStatus === "reconnect") return t`OAuth expired`;
  return server.hasSecret ? t`credential saved` : null;
}

function oauthActionLabel(server: McpServer, pending: boolean): string {
  if (pending) return t`Connecting…`;
  return server.oauthStatus === "none" ? t`Connect OAuth` : t`Reconnect OAuth`;
}

export function McpServersOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [botAssignments, setBotAssignments] = useState<Record<string, BotMcpServer[]>>({});
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [selectedBotIds, setSelectedBotIds] = useState<string[]>([]);
  const [transport, setTransport] = useState<McpTransport>("streamable_http");
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [secret, setSecret] = useState("");
  const [headerName, setHeaderName] = useState("Authorization");
  const [headerValue, setHeaderValue] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [oauthPending, setOauthPending] = useState<string | null>(null);

  async function refresh() {
    const [nextServers, nextBots, assignments] = await Promise.all([
      rpc.mcp.servers.list(),
      rpc.bots.list(),
      rpc.mcp.assignments.all(),
    ]);
    const activeBots = nextBots.filter((bot) => !bot.archivedAt);
    setServers(nextServers);
    setBots(activeBots);
    setBotAssignments(
      Object.fromEntries(
        activeBots.map((bot) => [
          bot.id,
          assignments.filter((assignment) => assignment.botId === bot.id),
        ]),
      ),
    );
  }

  useEffect(() => {
    void refresh().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : t`Could not load MCP servers`),
    );
  }, []);

  useEffect(() => {
    // BroadcastChannel instead of window.opener messaging: provider login
    // pages with COOP sever the opener link, but the channel is origin-scoped
    // and unaffected.
    const channel = new BroadcastChannel(MCP_OAUTH_CHANNEL);
    channel.onmessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type !== "mcp-oauth-complete") return;
      setOauthPending(null);
      void refresh().catch(() => undefined);
    };
    return () => channel.close();
  }, []);

  function toggleBot(id: string) {
    setSelectedBotIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  async function addServer() {
    setError(null);
    if (!name.trim()) {
      setError(t`Add a server name.`);
      return;
    }
    if (transport !== "stdio" && !endpoint.trim()) {
      setError(t`Add an HTTPS server URL.`);
      return;
    }
    if (transport === "stdio" && !command.trim()) {
      setError(t`Add a stdio command.`);
      return;
    }
    setSaving(true);
    try {
      const slug = deriveMcpSlug(name);
      const headers = headerValue.trim()
        ? { [headerName.trim() || "Authorization"]: headerValue.trim() }
        : {};
      const created =
        transport === "stdio"
          ? await rpc.mcp.servers.create({
              slug,
              name: name.trim(),
              transport,
              command: command.trim(),
              args: args.split(/\s+/).filter(Boolean),
              env: {},
              secret: secret || undefined,
              enabled: true,
            })
          : await rpc.mcp.servers.create({
              slug,
              name: name.trim(),
              transport,
              endpoint: endpoint.trim(),
              headers,
              secret: secret || undefined,
              enabled: true,
            });
      // replace() overwrites the bot's whole list, so merge with what it already has.
      await Promise.all(
        selectedBotIds.map((botId) => {
          const existing = (botAssignments[botId] ?? []).filter(
            (entry) => entry.serverId !== created.id,
          );
          return rpc.mcp.assignments.replace({
            botId,
            assignments: [
              ...existing,
              { serverId: created.id, allowAllTools: true, allowedTools: [] },
            ],
          });
        }),
      );
      await refresh();
      setName("");
      setEndpoint("");
      setSecret("");
      setHeaderValue("");
      setCommand("");
      setArgs("");
      setSelectedBotIds([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not add MCP server`);
    } finally {
      setSaving(false);
    }
  }

  async function connectOAuth(server: McpServer) {
    setError(null);
    setOauthPending(server.id);
    try {
      const result = await connectMcpOauth(server.id);
      if (result !== "cancelled") setOauthPending(null);
      await refresh();
      if (result === "connected") return;
      if (result === "already_connected") {
        setError(t`This server is already connected. Disconnect it first to authorize again.`);
        return;
      }
      if (result === "authorization_not_requested") {
        setError(t`This server did not request browser authorization.`);
        return;
      }
      setOauthPending((current) => (current === server.id ? null : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not start OAuth`);
      setOauthPending(null);
    }
  }

  async function toggleAssignment(server: McpServer, botId: string) {
    setError(null);
    const current = botAssignments[botId] ?? [];
    const assigned = current.some((entry) => entry.serverId === server.id);
    const next = assigned
      ? current.filter((entry) => entry.serverId !== server.id)
      : [...current, { serverId: server.id, allowAllTools: true, allowedTools: [] }];
    try {
      const updated = await rpc.mcp.assignments.replace({ botId, assignments: next });
      setBotAssignments((map) => ({ ...map, [botId]: updated }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not update agent access`);
    }
  }

  async function deleteServer(server: McpServer) {
    if (confirmingDelete !== server.id) {
      setConfirmingDelete(server.id);
      return;
    }
    setConfirmingDelete(null);
    setError(null);
    try {
      await rpc.mcp.servers.remove({ id: server.id });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not delete MCP server`);
    }
  }

  async function disconnectOAuth(server: McpServer) {
    setError(null);
    try {
      setOauthPending(server.id);
      await rpc.mcp.oauth.disconnect({ serverId: server.id });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not disconnect OAuth`);
    } finally {
      setOauthPending(null);
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
        className="flex max-h-[calc(100%-2rem)] w-[960px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-card p-0 sm:max-w-[960px]"
      >
        <DialogHeader className="flex-row items-center justify-between border-b border-border px-6 py-5">
          <DialogTitle className="text-xl text-foreground">
            <Trans>MCP servers</Trans>
          </DialogTitle>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close MCP servers`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>
        {error ? (
          <p
            role="alert"
            className="mx-6 mt-5 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
        <div className="rk-scroll grid min-h-0 grid-cols-1 gap-5 overflow-y-auto p-6 lg:grid-cols-2">
          <Card className="self-start">
            <CardHeader>
              <CardTitle>
                <Trans>Add server</Trans>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <FieldGroup className="gap-4">
                <Field>
                  <FieldLabel htmlFor="mcp-name">
                    <Trans>Server name</Trans>
                  </FieldLabel>
                  <Input
                    id="mcp-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Mobbin"
                  />
                </Field>
                <Tabs
                  value={transport}
                  onValueChange={(value) => setTransport(value as McpTransport)}
                >
                  <TabsList className="w-full">
                    <TabsTrigger value="streamable_http">HTTP</TabsTrigger>
                    <TabsTrigger value="sse">SSE</TabsTrigger>
                    <TabsTrigger value="stdio">STDIO</TabsTrigger>
                  </TabsList>
                </Tabs>
                {transport === "stdio" ? (
                  <>
                    <Field>
                      <FieldLabel htmlFor="mcp-command">
                        <Trans>Command</Trans>
                      </FieldLabel>
                      <Input
                        id="mcp-command"
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        placeholder="/opt/mcp-server"
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="mcp-args">
                        <Trans>Arguments</Trans>
                      </FieldLabel>
                      <Input
                        id="mcp-args"
                        value={args}
                        onChange={(e) => setArgs(e.target.value)}
                        placeholder="--stdio"
                      />
                    </Field>
                  </>
                ) : (
                  <Field>
                    <FieldLabel htmlFor="mcp-endpoint">
                      <Trans>Server URL</Trans>
                    </FieldLabel>
                    <Input
                      id="mcp-endpoint"
                      value={endpoint}
                      onChange={(e) => setEndpoint(e.target.value)}
                      placeholder="https://api.mobbin.com/mcp"
                    />
                  </Field>
                )}
                <details className="group rounded-xl border border-border">
                  <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-sm text-foreground">
                    <span>
                      <Trans>Advanced</Trans>
                    </span>
                    <span
                      aria-hidden="true"
                      className="text-muted-foreground transition-transform group-open:rotate-90"
                    >
                      ›
                    </span>
                  </summary>
                  <div className="space-y-4 border-t border-border p-3">
                    <Field>
                      <FieldLabel htmlFor="mcp-secret">
                        <Trans>Access token (optional)</Trans>
                      </FieldLabel>
                      <Input
                        id="mcp-secret"
                        type="password"
                        value={secret}
                        onChange={(e) => setSecret(e.target.value)}
                        placeholder={t`Stored encrypted`}
                      />
                    </Field>
                    {transport !== "stdio" ? (
                      <div className="grid grid-cols-[.7fr_1fr] gap-2">
                        <Input
                          aria-label={t`Header name`}
                          value={headerName}
                          onChange={(e) => setHeaderName(e.target.value)}
                        />
                        <Input
                          aria-label={t`Header value`}
                          type="password"
                          value={headerValue}
                          onChange={(e) => setHeaderValue(e.target.value)}
                          placeholder={t`Optional header value`}
                        />
                      </div>
                    ) : null}
                  </div>
                </details>
                {bots.length > 0 ? (
                  <Field>
                    <FieldTitle>
                      <Trans>Agents:</Trans>
                    </FieldTitle>
                    <div className="flex flex-wrap gap-1.5">
                      {bots.map((bot) => {
                        const selected = selectedBotIds.includes(bot.id);
                        return (
                          <Button
                            key={bot.id}
                            type="button"
                            variant={selected ? "default" : "outline"}
                            size="xs"
                            className="rounded-full"
                            aria-pressed={selected}
                            onClick={() => toggleBot(bot.id)}
                          >
                            {selected ? <Check aria-hidden="true" /> : null}
                            {bot.name}
                          </Button>
                        );
                      })}
                    </div>
                  </Field>
                ) : null}
              </FieldGroup>
              <Button
                type="button"
                className="mt-5 w-full"
                disabled={saving}
                onClick={() => void addServer()}
              >
                {saving ? <Trans>Adding…</Trans> : <Trans>Add server</Trans>}
              </Button>
            </CardContent>
          </Card>
          <div>
            <h2 className="text-[15px] font-medium text-foreground">
              <Trans>Configured servers</Trans>
            </h2>
            <div className="mt-3 space-y-2">
              {servers.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">
                  <Trans>No MCP servers yet.</Trans>
                </p>
              ) : (
                servers.map((server) => {
                  const statusText = oauthStatusText(server);
                  return (
                    <Card key={server.id} size="sm">
                      <CardContent>
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-foreground">{server.name}</span>
                          <Badge variant="secondary" className="uppercase">
                            {server.transport.replace("_", " ")}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {server.endpoint ?? server.command ?? server.slug}
                        </p>
                        {statusText ? (
                          <p
                            className={`mt-2 text-[11px] ${server.oauthStatus === "reconnect" ? "text-warning" : "text-muted-foreground"}`}
                          >
                            {statusText}
                          </p>
                        ) : null}
                        <div className="mt-3 flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] text-muted-foreground">
                            <Trans>Agents:</Trans>
                          </span>
                          {bots.map((bot) => {
                            const assigned = (botAssignments[bot.id] ?? []).some(
                              (entry) => entry.serverId === server.id,
                            );
                            return (
                              <Button
                                key={bot.id}
                                type="button"
                                variant={assigned ? "default" : "outline"}
                                size="xs"
                                className="rounded-full"
                                aria-pressed={assigned}
                                onClick={() => void toggleAssignment(server, bot.id)}
                              >
                                {assigned ? <Check aria-hidden="true" /> : null}
                                {bot.name}
                              </Button>
                            );
                          })}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {server.transport !== "stdio" ? (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                disabled={oauthPending === server.id}
                                onClick={() => void connectOAuth(server)}
                              >
                                {oauthActionLabel(server, oauthPending === server.id)}
                              </Button>
                              {server.oauthStatus !== "none" ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={oauthPending === server.id}
                                  onClick={() => void disconnectOAuth(server)}
                                >
                                  <Trans>Disconnect</Trans>
                                </Button>
                              ) : null}
                            </>
                          ) : null}
                          <Button
                            type="button"
                            variant={confirmingDelete === server.id ? "destructive" : "outline"}
                            size="sm"
                            className="ml-auto"
                            onClick={() => void deleteServer(server)}
                          >
                            {confirmingDelete === server.id ? (
                              <Trans>Confirm delete</Trans>
                            ) : (
                              <Trans>Delete</Trans>
                            )}
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
