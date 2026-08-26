import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, BotMcpServer, McpServer, McpTransport } from "@rakazo/contracts";
import { deriveMcpSlug } from "@rakazo/core";
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
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-[rgba(4,4,5,.62)] p-6">
      <section
        className="flex max-h-full w-[1080px] max-w-full flex-col overflow-hidden rounded-[26px] border border-[#2A2A31] bg-[#141416] shadow-[0_40px_90px_rgba(0,0,0,.55)]"
        aria-label={t`MCP servers`}
      >
        <header className="flex items-start justify-between border-b border-[#27272C] px-8 py-6">
          <div>
            <h1 className="text-2xl font-medium text-[#F1F1F2]">
              <Trans>MCP servers</Trans>
            </h1>
            <p className="mt-1 text-[13.5px] text-[#85858B]">
              <Trans>
                Connect remote or local tool servers and choose which agents can use them.
              </Trans>
            </p>
          </div>
          <button
            type="button"
            aria-label={t`Close MCP servers`}
            onClick={onClose}
            className="text-xl text-[#85858A]"
          >
            ✕
          </button>
        </header>
        {error ? (
          <p className="mx-8 mt-5 rounded-xl border border-[#6A2C37] bg-[#2A151A] p-3 text-xs text-[#F3A2AA]">
            {error}
          </p>
        ) : null}
        <div className="rk-scroll grid min-h-0 grid-cols-1 gap-6 overflow-y-auto p-8 lg:grid-cols-[1fr_1.08fr]">
          <div className="rounded-2xl border border-[#292930] bg-[#101012] p-5">
            <h2 className="text-[15px] font-medium text-[#ECECEE]">
              <Trans>Add a server</Trans>
            </h2>
            <p className="mb-5 mt-1 text-xs text-[#77777F]">
              <Trans>
                OAuth will be available for providers that support browser authorization. Static
                headers work today.
              </Trans>
            </p>
            <label className="mb-1.5 block text-xs text-[#B9B9C0]" htmlFor="mcp-name">
              <Trans>Server name</Trans>
            </label>
            <input
              id="mcp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Mobbin"
              className="mb-4 w-full rounded-xl border border-[#303038] bg-[#0B0B0D] px-3 py-2.5 text-sm text-white outline-none"
            />
            <div className="mb-4 grid grid-cols-3 gap-1 rounded-xl border border-[#303038] bg-[#0B0B0D] p-1">
              {(
                [
                  ["streamable_http", "HTTP"],
                  ["sse", "SSE"],
                  ["stdio", "STDIO"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={transport === value}
                  onClick={() => setTransport(value)}
                  className={`rounded-lg px-2 py-2 text-xs ${transport === value ? "bg-[#30356A] text-[#E2E4FF]" : "text-[#85858B]"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {transport === "stdio" ? (
              <>
                <label className="mb-1.5 block text-xs text-[#B9B9C0]" htmlFor="mcp-command">
                  <Trans>Command</Trans>
                </label>
                <input
                  id="mcp-command"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="/opt/mcp-server"
                  className="mb-4 w-full rounded-xl border border-[#303038] bg-[#0B0B0D] px-3 py-2.5 text-sm text-white outline-none"
                />
                <label className="mb-1.5 block text-xs text-[#B9B9C0]" htmlFor="mcp-args">
                  <Trans>Arguments</Trans>
                </label>
                <input
                  id="mcp-args"
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder="--stdio"
                  className="mb-4 w-full rounded-xl border border-[#303038] bg-[#0B0B0D] px-3 py-2.5 text-sm text-white outline-none"
                />
              </>
            ) : (
              <>
                <label className="mb-1.5 block text-xs text-[#B9B9C0]" htmlFor="mcp-endpoint">
                  <Trans>Server URL</Trans>
                </label>
                <input
                  id="mcp-endpoint"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://api.mobbin.com/mcp"
                  className="mb-4 w-full rounded-xl border border-[#303038] bg-[#0B0B0D] px-3 py-2.5 text-sm text-white outline-none"
                />
              </>
            )}
            <label className="mb-1.5 block text-xs text-[#B9B9C0]" htmlFor="mcp-secret">
              <Trans>Access token (optional)</Trans>
            </label>
            <input
              id="mcp-secret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={t`Stored encrypted`}
              className="mb-3 w-full rounded-xl border border-[#303038] bg-[#0B0B0D] px-3 py-2.5 text-sm text-white outline-none"
            />
            {transport !== "stdio" ? (
              <div className="grid grid-cols-[.7fr_1fr] gap-2">
                <input
                  aria-label={t`Header name`}
                  value={headerName}
                  onChange={(e) => setHeaderName(e.target.value)}
                  className="rounded-xl border border-[#303038] bg-[#0B0B0D] px-3 py-2.5 text-xs text-white outline-none"
                />
                <input
                  aria-label={t`Header value`}
                  type="password"
                  value={headerValue}
                  onChange={(e) => setHeaderValue(e.target.value)}
                  placeholder={t`Optional header value`}
                  className="rounded-xl border border-[#303038] bg-[#0B0B0D] px-3 py-2.5 text-xs text-white outline-none"
                />
              </div>
            ) : null}
            <button
              type="button"
              disabled={saving}
              onClick={() => void addServer()}
              className="mt-5 w-full rounded-xl bg-[#7785FF] px-4 py-3 text-sm font-semibold text-[#090A12] disabled:opacity-50"
            >
              {saving ? <Trans>Adding…</Trans> : <Trans>Add server</Trans>}
            </button>
          </div>
          <div className="space-y-5">
            <div>
              <h2 className="text-[15px] font-medium text-[#ECECEE]">
                <Trans>Agent access for new servers</Trans>
              </h2>
              <p className="mt-1 text-xs text-[#77777F]">
                <Trans>
                  Applies when you click Add server. Use the agent chips on each server card to
                  change access at any time — the agent picks it up on its next message.
                </Trans>
              </p>
              <div className="mt-3 space-y-2">
                {bots.map((bot) => (
                  <label
                    key={bot.id}
                    className="flex cursor-pointer items-center gap-3 rounded-xl border border-[#292930] bg-[#101012] px-3 py-3"
                  >
                    <input
                      type="checkbox"
                      checked={selectedBotIds.includes(bot.id)}
                      onChange={() => toggleBot(bot.id)}
                      className="accent-[#7785FF]"
                    />
                    <span className="grid h-8 w-8 place-items-center rounded-lg bg-[#30356A] text-xs text-[#E2E4FF]">
                      {bot.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span>
                      <span className="block text-sm text-[#E4E4E7]">{bot.name}</span>
                      <span className="block text-xs text-[#77777F]">{bot.title}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <h2 className="text-[15px] font-medium text-[#ECECEE]">
                <Trans>Configured servers</Trans>
              </h2>
              <div className="mt-3 space-y-2">
                {servers.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-[#34343B] p-5 text-sm text-[#77777F]">
                    <Trans>No MCP servers yet.</Trans>
                  </p>
                ) : (
                  servers.map((server) => (
                    <div
                      key={server.id}
                      className="rounded-xl border border-[#292930] bg-[#101012] p-4"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-[#ECECEE]">{server.name}</span>
                        <span className="rounded-full bg-[#202536] px-2 py-1 text-[10px] uppercase text-[#AEB7FF]">
                          {server.transport.replace("_", " ")}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-[#77777F]">
                        {server.endpoint ?? server.command ?? server.slug}
                      </p>
                      <p
                        className={`mt-2 text-[11px] ${server.oauthStatus === "reconnect" ? "text-[#F0A15A]" : "text-[#6E778A]"}`}
                      >
                        {oauthStatusText(server)}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] text-[#77777F]">
                          <Trans>Agents:</Trans>
                        </span>
                        {bots.map((bot) => {
                          const assigned = (botAssignments[bot.id] ?? []).some(
                            (entry) => entry.serverId === server.id,
                          );
                          return (
                            <button
                              key={bot.id}
                              type="button"
                              onClick={() => void toggleAssignment(server, bot.id)}
                              className={`rounded-full border px-2.5 py-1 text-[11px] ${assigned ? "border-[#7785FF] bg-[#30356A] text-[#E2E4FF]" : "border-[#34343B] text-[#85858B]"}`}
                            >
                              {assigned ? "✓ " : ""}
                              {bot.name}
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {server.transport !== "stdio" ? (
                          <>
                            <button
                              type="button"
                              disabled={oauthPending === server.id}
                              onClick={() => void connectOAuth(server)}
                              className="rounded-lg bg-[#7785FF] px-3 py-2 text-xs font-semibold text-[#090A12] disabled:opacity-50"
                            >
                              {oauthActionLabel(server, oauthPending === server.id)}
                            </button>
                            {server.oauthStatus !== "none" ? (
                              <button
                                type="button"
                                disabled={oauthPending === server.id}
                                onClick={() => void disconnectOAuth(server)}
                                className="rounded-lg border border-[#34343B] px-3 py-2 text-xs text-[#B9B9C0]"
                              >
                                <Trans>Disconnect</Trans>
                              </button>
                            ) : null}
                          </>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => void deleteServer(server)}
                          className={`ml-auto rounded-lg border px-3 py-2 text-xs ${confirmingDelete === server.id ? "border-[#B4434F] bg-[#3A1A20] text-[#F3A2AA]" : "border-[#34343B] text-[#B9B9C0]"}`}
                        >
                          {confirmingDelete === server.id ? (
                            <Trans>Confirm delete</Trans>
                          ) : (
                            <Trans>Delete</Trans>
                          )}
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
