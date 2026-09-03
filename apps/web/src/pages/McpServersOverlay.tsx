import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, BotMcpServer, McpServer, McpTransport } from "@rakazo/contracts";
import { deriveMcpSlug } from "@rakazo/core";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  Label,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@rakazo/ui-web";
import { Check, X } from "lucide-react";
import { useEffect, useState } from "react";
import { connectMcpOauth, MCP_OAUTH_CHANNEL } from "../lib/mcp-connect";
import { rpc } from "../lib/rpc";

function oauthStatusText(server: McpServer): string {
  if (server.oauthStatus === "connected") return t`OAuth connected`;
  if (server.oauthStatus === "reconnect") return t`Authorization expired — reconnect required`;
  return server.hasSecret ? t`Encrypted static credential saved` : t`No credential saved`;
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
        className="flex max-h-[calc(100%-2rem)] w-[1080px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-card p-0 sm:max-w-[1080px]"
      >
        <DialogHeader className="flex-row items-start justify-between border-b border-border px-8 py-6">
          <div>
            <DialogTitle className="text-2xl text-foreground">
              <Trans>MCP servers</Trans>
            </DialogTitle>
            <DialogDescription className="mt-1 text-[13.5px]">
              <Trans>
                Connect remote or local tool servers and choose which agents can use them.
              </Trans>
            </DialogDescription>
          </div>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close MCP servers`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>
        {error ? (
          <p
            role="alert"
            className="mx-8 mt-5 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
        <div className="rk-scroll grid min-h-0 grid-cols-1 gap-6 overflow-y-auto p-8 lg:grid-cols-[1fr_1.08fr]">
          <Card className="self-start">
            <CardHeader>
              <CardTitle>
                <Trans>Add a server</Trans>
              </CardTitle>
              <CardDescription className="text-xs">
                <Trans>
                  OAuth will be available for providers that support browser authorization. Static
                  headers work today.
                </Trans>
              </CardDescription>
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
          <div className="space-y-5">
            <div>
              <h2 className="text-[15px] font-medium text-foreground">
                <Trans>Agent access for new servers</Trans>
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                <Trans>
                  Applies when you click Add server. Use the agent chips on each server card to
                  change access at any time — the agent picks it up on its next message.
                </Trans>
              </p>
              <div className="mt-3 space-y-2">
                {bots.map((bot) => (
                  <Label
                    key={bot.id}
                    className="cursor-pointer gap-3 rounded-xl border border-border px-3 py-3 font-normal"
                  >
                    <Checkbox
                      aria-label={bot.name}
                      checked={selectedBotIds.includes(bot.id)}
                      onCheckedChange={() => toggleBot(bot.id)}
                    />
                    <span className="grid h-8 w-8 place-items-center rounded-lg bg-muted text-xs text-foreground">
                      {bot.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span>
                      <span className="block text-sm text-foreground">{bot.name}</span>
                      <span className="block text-xs text-muted-foreground">{bot.title}</span>
                    </span>
                  </Label>
                ))}
              </div>
            </div>
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
                  servers.map((server) => (
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
                        <p
                          className={`mt-2 text-[11px] ${server.oauthStatus === "reconnect" ? "text-warning" : "text-muted-foreground"}`}
                        >
                          {oauthStatusText(server)}
                        </p>
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
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
