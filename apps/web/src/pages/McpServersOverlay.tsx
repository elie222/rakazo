import { t } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { BotMcpServer, McpServer, McpTransport } from "@rakazo/contracts";
import { MCP_OAUTH_CLIENT_REQUIRED } from "@rakazo/contracts";
import { deriveMcpSlug, isRetryableError } from "@rakazo/core";
import { fetchFresh, writeSaved } from "@rakazo/core/query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
  Input,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
  Toggle,
  toast,
} from "@rakazo/ui-web";
import { Disclosure } from "@rakazo/ui-web/components/ui/disclosure";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Ellipsis, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentAccess } from "../components/integrations/agent-access";
import { AgentAccessControl } from "../components/integrations/agent-access";
import {
  AvailabilityControl,
  reachesOtherSpaces,
  useOwnSpaces,
} from "../components/integrations/space-availability";
import { McpServerHealthLine } from "../components/McpServerHealthLine";
import { connectMcpOauth, MCP_OAUTH_CHANNEL, mcpOAuthRedirectUri } from "../lib/mcp-connect";
import { useSpaceQueries } from "../lib/query";
import { rpc } from "../lib/rpc";
import { errorCode, errorText } from "../lib/user-error";

/** How often the list is re-read while a server installs its package or is being tested. */
const INSTALL_POLL_MS = 2500;

type EnvRow = { id: number; name: string; value: string; file: boolean };

/** How an env value asks Rakazo to inject the granted OAuth access token. */
const oauthEnvReference = "{{oauth.access_token}}";

let nextEnvRowId = 0;
const emptyEnvRow = (): EnvRow => ({
  id: nextEnvRowId++,
  name: "",
  value: "",
  file: false,
});

/** Environment variable names the server accepts: capitals, digits, and underscores. */
function envName(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/^(?=[0-9])/, "_");
}

/** A server whose authorization server cannot register a client until the user enters one. */
function needsOAuthClient(server: McpServer): boolean {
  return server.health.code === MCP_OAUTH_CLIENT_REQUIRED && !server.oauthClientId;
}

function sameAccess(a: AgentAccess, b: AgentAccess): boolean {
  return a.allBots === b.allBots && [...a.botIds].sort().join() === [...b.botIds].sort().join();
}

function oauthActionLabel(server: McpServer, pending: boolean): string {
  if (pending) return t`Connecting…`;
  return server.oauthStatus === "none" ? t`Connect OAuth` : t`Reconnect OAuth`;
}

export function McpServersOverlay({
  onClose,
  editServerId,
  stdioEnabled,
}: {
  onClose: () => void;
  /** Opens with this server's form, as an import's setup checklist does. */
  editServerId?: string;
  /** Whether this deployment runs stdio servers. */
  stdioEnabled: boolean;
}) {
  const { t } = useLingui();
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<McpServer | null>(null);
  const [formAccess, setFormAccess] = useState<AgentAccess>({ allBots: true, botIds: [] });
  const [transport, setTransport] = useState<McpTransport>("streamable_http");
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [secret, setSecret] = useState("");
  const [headerName, setHeaderName] = useState("Authorization");
  const [headerValue, setHeaderValue] = useState("");
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [oauthAuthorizationServer, setOauthAuthorizationServer] = useState("");
  const [oauthScope, setOauthScope] = useState("");
  const [oauthParams, setOauthParams] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [focusOAuthClient, setFocusOAuthClient] = useState(false);
  const oauthClientIdInput = useRef<HTMLInputElement>(null);
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [verbatimResults, setVerbatimResults] = useState(false);
  const [envRows, setEnvRows] = useState<EnvRow[]>(() => [emptyEnvRow()]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [oauthPending, setOauthPending] = useState<string | null>(null);
  const [testingIds, setTestingIds] = useState<Set<string>>(() => new Set());
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const serversOptions = queries.mcp.servers.list.queryOptions();
  const serversQuery = useQuery({
    ...serversOptions,
    // A freshly saved stdio server installs its package in the background, so its health
    // moves installing -> ok/error on its own, and a test can spend minutes installing.
    // Re-read the list while either is true so the card follows along; a refused request
    // stops it.
    refetchInterval: (query) => {
      const error = query.state.error;
      if (error && !isRetryableError(error)) return false;
      const installing = query.state.data?.some((server) => server.health.status === "installing");
      return testingIds.size > 0 || installing ? INSTALL_POLL_MS : false;
    },
  });
  const botsOptions = queries.bots.list.queryOptions();
  const botsQuery = useQuery(botsOptions);
  const assignmentsOptions = queries.mcp.assignments.all.queryOptions();
  const assignmentsQuery = useQuery(assignmentsOptions);
  const servers = serversQuery.data ?? [];
  const spaceCount = useOwnSpaces().length;
  const bots = useMemo(
    () => (botsQuery.data ?? []).filter((bot) => !bot.archivedAt),
    [botsQuery.data],
  );
  const botAssignments = useMemo(() => {
    const assignments = assignmentsQuery.data ?? [];
    return Object.fromEntries(
      bots.map((bot) => [bot.id, assignments.filter((assignment) => assignment.botId === bot.id)]),
    ) as Record<string, BotMcpServer[]>;
  }, [bots, assignmentsQuery.data]);
  // replace() overwrites a bot's whole list, so changes wait for a read of every assignment.
  const assignmentsReady = assignmentsQuery.isSuccess && !assignmentsQuery.isFetching;
  const loadFailed = serversQuery.isError || botsQuery.isError || assignmentsQuery.isError;
  const shownError = error ?? (loadFailed ? t`Could not load MCP servers` : null);

  /** Reads everything again with requests sent after a change. */
  async function refresh() {
    await Promise.all([
      fetchFresh(queryClient, serversOptions),
      fetchFresh(queryClient, botsOptions),
      fetchFresh(queryClient, assignmentsOptions),
    ]);
  }

  const openedEditServer = useRef(false);
  useEffect(() => {
    if (!editServerId || openedEditServer.current) return;
    const server = servers.find((item) => item.id === editServerId);
    if (!server) return;
    openedEditServer.current = true;
    startEditing(server);
  }, [editServerId, servers]);

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
  }, [queries]);

  const duplicateNames = new Set(
    envRows
      .filter(
        (row, index) =>
          row.name &&
          envRows.some(
            (other, otherIndex) =>
              otherIndex !== index && envName(other.name) === envName(row.name),
          ),
      )
      .map((row) => row.name),
  );

  function resetForm() {
    setEditing(null);
    setAdding(false);
    setFormAccess({ allBots: true, botIds: [] });
    if (!stdioEnabled) setTransport("streamable_http");
    setName("");
    setEndpoint("");
    setSecret("");
    setHeaderName("Authorization");
    setHeaderValue("");
    setOauthClientId("");
    setOauthClientSecret("");
    setOauthAuthorizationServer("");
    setOauthScope("");
    setOauthParams("");
    setAdvancedOpen(false);
    setCommand("");
    setArgs("");
    setVerbatimResults(false);
    setEnvRows([emptyEnvRow()]);
  }

  /** Stored values are never sent back to the client, so a blank one keeps what is stored. */
  function startEditing(server: McpServer, showOAuthClient = needsOAuthClient(server)) {
    resetForm();
    setError(null);
    setEditing(server);
    setFormAccess(accessOf(server));
    setName(server.name);
    setTransport(server.transport);
    setEndpoint(server.endpoint ?? "");
    setCommand(server.command ?? "");
    setVerbatimResults(server.verbatimResults);
    setHeaderName(server.headerKeys[0] ?? "Authorization");
    const rows = [
      ...server.envKeys.map((name) => ({ ...emptyEnvRow(), name })),
      ...server.fileKeys.map((name) => ({ ...emptyEnvRow(), name, file: true })),
    ];
    if (rows.length > 0) setEnvRows(rows);
    if (showOAuthClient) {
      setAdvancedOpen(true);
      setFocusOAuthClient(true);
    }
  }

  useEffect(() => {
    if (!focusOAuthClient || !advancedOpen) return;
    oauthClientIdInput.current?.focus();
    setFocusOAuthClient(false);
  }, [focusOAuthClient, advancedOpen]);

  async function saveServer() {
    if (transport === "stdio" && duplicateNames.size > 0) return;
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
      const headers = {
        ...Object.fromEntries((editing?.headerKeys ?? []).map((key) => [key, ""])),
        ...(headerValue.trim()
          ? { [headerName.trim() || "Authorization"]: headerValue.trim() }
          : {}),
      };
      const oauthBase = oauthClientId.trim()
        ? {
            clientId: oauthClientId.trim(),
            clientSecret: oauthClientSecret || undefined,
            scope: oauthScope.trim() || undefined,
            authorizationParams: oauthParams.trim() || undefined,
          }
        : undefined;
      const envEntries = (file: boolean) =>
        Object.fromEntries(
          envRows
            .filter((row) => row.name && row.file === file)
            .map((row) => [row.name, row.value]),
        );
      const config =
        transport === "stdio"
          ? {
              slug,
              name: name.trim(),
              transport,
              command: command.trim(),
              args: args.split(/\s+/).filter(Boolean),
              env: envEntries(false),
              files: envEntries(true),
              secret: secret || undefined,
              oauthClient: oauthBase
                ? {
                    ...oauthBase,
                    authorizationServer: oauthAuthorizationServer.trim(),
                  }
                : undefined,
              enabled: true,
              verbatimResults,
            }
          : {
              slug,
              name: name.trim(),
              transport,
              endpoint: endpoint.trim(),
              headers,
              secret: secret || undefined,
              oauthClient: oauthBase,
              enabled: true,
              verbatimResults,
            };
      if (editing) {
        await rpc.mcp.servers.update({
          id: editing.id,
          config: {
            ...config,
            slug: editing.slug,
            description: editing.description,
            enabled: editing.enabled,
          },
        });
        if (!sameAccess(formAccess, accessOf(editing)))
          await rpc.mcp.servers.agents({ id: editing.id, ...formAccess });
        await refresh();
        resetForm();
        return;
      }
      const created = await rpc.mcp.servers.create(config);
      if (!formAccess.allBots) await rpc.mcp.servers.agents({ id: created.id, ...formAccess });
      await refresh();
      resetForm();
      // A remote server is checked in the background; wait for that check so a server
      // that cannot work as entered says so now. It starts after the refresh, whose read
      // the test's cache write would otherwise cancel.
      if (created.health.status === "unknown" && !created.health.checkedAt)
        void testServer(created, false);
    } catch (err) {
      setError(errorText(err, editing ? t`Could not save` : t`Could not add MCP server`));
    } finally {
      setSaving(false);
    }
  }

  function updateEnvRow(id: number, patch: Partial<EnvRow>) {
    setEnvRows((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
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
      setOauthPending(null);
      if (errorCode(err) === MCP_OAUTH_CLIENT_REQUIRED) {
        startEditing(server, true);
        void refresh().catch(() => undefined);
      }
      setError(errorText(err, t`Could not start OAuth`));
    }
  }

  async function setServerAgents(server: McpServer, access: AgentAccess) {
    if (!assignmentsReady) return;
    setError(null);
    try {
      const updated = await rpc.mcp.servers.agents({ id: server.id, ...access });
      await Promise.all([
        writeSaved(queryClient, serversOptions.queryKey, (current) =>
          (current ?? []).map((item) => (item.id === server.id ? updated.server : item)),
        ),
        writeSaved(queryClient, assignmentsOptions.queryKey, (all) => [
          ...(all ?? []).filter((entry) => entry.serverId !== server.id),
          ...updated.assignments,
        ]),
      ]);
    } catch (err) {
      setError(errorText(err, t`Could not update bot access`));
    }
  }

  function accessOf(server: McpServer): AgentAccess {
    return {
      allBots: server.allBots ?? false,
      botIds: bots
        .filter((bot) =>
          (botAssignments[bot.id] ?? []).some((entry) => entry.serverId === server.id),
        )
        .map((bot) => bot.id),
    };
  }

  async function deleteServer(server: McpServer) {
    setDeleting(null);
    setError(null);
    try {
      await rpc.mcp.servers.remove({ id: server.id });
      if (editing?.id === server.id) resetForm();
      await refresh();
    } catch (err) {
      setError(errorText(err, t`Could not delete MCP server`));
    }
  }

  async function testServer(server: McpServer, announce = true) {
    setError(null);
    setTestingIds((current) => new Set(current).add(server.id));
    try {
      const updated = await rpc.mcp.servers.test({ id: server.id });
      await writeSaved(queryClient, serversOptions.queryKey, (current) =>
        (current ?? []).map((item) => (item.id === updated.id ? updated : item)),
      );
      if (!announce) return;
      if (updated.health.status === "ok") {
        toast.success(t`${updated.name} is running`);
      } else if (updated.health.status === "error") {
        toast.error(t`${updated.name} is not working`);
      }
    } catch (err) {
      setError(errorText(err, t`Could not test MCP server`));
    } finally {
      setTestingIds((current) => {
        const next = new Set(current);
        next.delete(server.id);
        return next;
      });
    }
  }

  async function disconnectOAuth(server: McpServer) {
    setError(null);
    try {
      setOauthPending(server.id);
      await rpc.mcp.oauth.disconnect({ serverId: server.id });
      await refresh();
    } catch (err) {
      setError(errorText(err, t`Could not disconnect OAuth`));
    } finally {
      setOauthPending(null);
    }
  }

  const formOpen = adding || editing !== null || (serversQuery.isSuccess && servers.length === 0);

  function renderForm() {
    return (
      <div className="space-y-5">
        <div className="flex items-center gap-2">
          {servers.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="-ms-2 text-muted-foreground"
              aria-label={t`Back`}
              disabled={saving}
              onClick={resetForm}
            >
              <ChevronLeft />
            </Button>
          ) : null}
          <h3 className="text-[17px] font-medium text-foreground">
            {editing ? editing.name : <Trans>Add server</Trans>}
          </h3>
        </div>
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
          <Tabs value={transport} onValueChange={(value) => setTransport(value as McpTransport)}>
            <TabsList className="w-full">
              <TabsTrigger value="streamable_http">HTTP</TabsTrigger>
              <TabsTrigger value="sse">SSE</TabsTrigger>
              {stdioEnabled || editing?.transport === "stdio" ? (
                <TabsTrigger value="stdio">STDIO</TabsTrigger>
              ) : null}
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
                  placeholder={editing?.hasArgs ? t`Stored encrypted` : "--stdio"}
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
                type="url"
                autoComplete="off"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder="https://api.mobbin.com/mcp"
              />
            </Field>
          )}
          <Disclosure
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            className="group rounded-xl border border-border"
            summary={<Trans>Advanced</Trans>}
            summaryClassName="w-full flex items-center justify-between px-3 py-2.5 text-sm text-foreground"
          >
            <div className="space-y-4 border-t border-border p-3">
              <Field>
                <FieldLabel htmlFor="mcp-secret">
                  <Trans>Access token (optional)</Trans>
                </FieldLabel>
                <Input
                  id="mcp-secret"
                  type="password"
                  autoComplete="new-password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={t`Stored encrypted`}
                />
              </Field>
              {transport === "stdio" ? (
                <Field>
                  <FieldTitle>
                    <Trans>Environment variables</Trans>
                  </FieldTitle>
                  {envRows.map((row) => (
                    <Field
                      key={row.id}
                      orientation="horizontal"
                      data-invalid={duplicateNames.has(row.name) || undefined}
                      className="grid grid-cols-[.7fr_1fr_auto_auto] items-start gap-2"
                    >
                      <Input
                        aria-label={t`Name`}
                        aria-invalid={duplicateNames.has(row.name) || undefined}
                        aria-describedby={
                          duplicateNames.has(row.name) ? `mcp-env-error-${row.id}` : undefined
                        }
                        autoComplete="off"
                        className={row.file ? "col-span-2" : undefined}
                        value={row.name}
                        onChange={(e) =>
                          updateEnvRow(row.id, {
                            name: envName(e.target.value),
                          })
                        }
                        placeholder="API_KEY"
                      />
                      {row.file ? null : (
                        <Input
                          aria-label={t`Value`}
                          type={row.value.includes("{{oauth.") ? "text" : "password"}
                          autoComplete={row.value.includes("{{oauth.") ? "off" : "new-password"}
                          value={row.value}
                          onChange={(e) =>
                            updateEnvRow(row.id, {
                              value: e.target.value,
                            })
                          }
                          placeholder={t`Stored encrypted`}
                        />
                      )}
                      <Toggle
                        variant="outline"
                        size="sm"
                        pressed={row.file}
                        onPressedChange={(file) => updateEnvRow(row.id, { file })}
                      >
                        <Trans>File</Trans>
                      </Toggle>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t`Remove`}
                        onClick={() =>
                          setEnvRows((rows) =>
                            rows.length > 1
                              ? rows.filter((item) => item.id !== row.id)
                              : [emptyEnvRow()],
                          )
                        }
                      >
                        <X />
                      </Button>
                      {row.file ? (
                        <Textarea
                          aria-label={t`Value`}
                          autoComplete="off"
                          spellCheck={false}
                          className="col-span-full min-h-24 font-mono text-xs"
                          value={row.value}
                          onChange={(e) =>
                            updateEnvRow(row.id, {
                              value: e.target.value,
                            })
                          }
                        />
                      ) : null}
                      {duplicateNames.has(row.name) ? (
                        <FieldError id={`mcp-env-error-${row.id}`} className="col-span-full">
                          <Trans>Each name can be used once.</Trans>
                        </FieldError>
                      ) : null}
                    </Field>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="self-start"
                    onClick={() => setEnvRows((rows) => [...rows, emptyEnvRow()])}
                  >
                    <Trans>Add</Trans>
                  </Button>
                  {oauthClientId.trim() ? (
                    <p className="text-xs text-muted-foreground">
                      <Trans>Use {oauthEnvReference} for the access token.</Trans>
                    </p>
                  ) : null}
                </Field>
              ) : (
                <div className="grid grid-cols-[.7fr_1fr] gap-2">
                  <Input
                    aria-label={t`Header name`}
                    value={headerName}
                    onChange={(e) => setHeaderName(e.target.value)}
                  />
                  <Input
                    aria-label={t`Header value`}
                    type="password"
                    autoComplete="new-password"
                    value={headerValue}
                    onChange={(e) => setHeaderValue(e.target.value)}
                    placeholder={t`Optional header value`}
                  />
                </div>
              )}
              <Field>
                <FieldLabel htmlFor="mcp-oauth-client-id">
                  <Trans>OAuth client ID (optional)</Trans>
                </FieldLabel>
                <Input
                  ref={oauthClientIdInput}
                  id="mcp-oauth-client-id"
                  autoComplete="off"
                  value={oauthClientId}
                  onChange={(e) => setOauthClientId(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="mcp-oauth-client-secret">
                  <Trans>OAuth client secret (optional)</Trans>
                </FieldLabel>
                <Input
                  id="mcp-oauth-client-secret"
                  type="password"
                  autoComplete="new-password"
                  value={oauthClientSecret}
                  onChange={(e) => setOauthClientSecret(e.target.value)}
                  placeholder={t`Stored encrypted`}
                />
              </Field>
              {oauthClientId.trim() ? (
                <>
                  {transport === "stdio" ? (
                    <Field>
                      <FieldLabel htmlFor="mcp-oauth-authorization-server">
                        <Trans>Authorization server</Trans>
                      </FieldLabel>
                      <Input
                        id="mcp-oauth-authorization-server"
                        type="url"
                        autoComplete="off"
                        value={oauthAuthorizationServer}
                        onChange={(e) => setOauthAuthorizationServer(e.target.value)}
                        placeholder="https://accounts.google.com"
                      />
                    </Field>
                  ) : null}
                  <Field>
                    <FieldLabel htmlFor="mcp-oauth-scope">
                      <Trans>Scopes (optional)</Trans>
                    </FieldLabel>
                    <Input
                      id="mcp-oauth-scope"
                      autoComplete="off"
                      value={oauthScope}
                      onChange={(e) => setOauthScope(e.target.value)}
                      placeholder="openid email"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="mcp-oauth-params">
                      <Trans>Authorization parameters (optional)</Trans>
                    </FieldLabel>
                    <Input
                      id="mcp-oauth-params"
                      autoComplete="off"
                      value={oauthParams}
                      onChange={(e) => setOauthParams(e.target.value)}
                      placeholder="access_type=offline&prompt=consent"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="mcp-oauth-redirect-uri">
                      <Trans>Redirect URI</Trans>
                    </FieldLabel>
                    <Input
                      id="mcp-oauth-redirect-uri"
                      readOnly
                      value={mcpOAuthRedirectUri()}
                      onFocus={(e) => e.target.select()}
                    />
                  </Field>
                </>
              ) : null}
              <Field orientation="horizontal">
                <Checkbox
                  id="mcp-verbatim-results"
                  checked={verbatimResults}
                  onCheckedChange={(checked) => setVerbatimResults(checked === true)}
                />
                <FieldLabel htmlFor="mcp-verbatim-results">
                  <Trans>Keep tool results whole</Trans>
                </FieldLabel>
              </Field>
            </div>
          </Disclosure>
        </FieldGroup>
        <AgentAccessControl
          bots={bots}
          access={formAccess}
          disabled={!assignmentsReady}
          onChange={setFormAccess}
        />
        <Button
          type="button"
          className="w-full"
          disabled={saving || (transport === "stdio" && duplicateNames.size > 0)}
          onClick={() => void saveServer()}
        >
          {editing ? (
            saving ? (
              <Trans>Saving…</Trans>
            ) : (
              <Trans>Save</Trans>
            )
          ) : saving ? (
            <Trans>Adding…</Trans>
          ) : (
            <Trans>Add server</Trans>
          )}
        </Button>
      </div>
    );
  }

  function renderServer(server: McpServer) {
    const oauth =
      (server.transport !== "stdio" || server.oauthClientId) && !needsOAuthClient(server);
    // A working server does not need signing in up front, so the action waits in its menu.
    const signInFirst =
      oauth &&
      (server.oauthStatus === "reconnect" ||
        (server.oauthStatus === "none" && server.health.status !== "ok"));
    const pending = oauthPending === server.id;
    const testing = testingIds.has(server.id);
    const working = server.health.status === "ok" && !testing;
    return (
      <li
        key={server.id}
        data-testid="mcp-server"
        className="flex items-start justify-between gap-3 py-3"
      >
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium text-foreground">{server.name}</span>
            {working && server.health.toolCount !== null ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                <Plural value={server.health.toolCount} one="# tool" other="# tools" />
              </span>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {server.endpoint ?? server.command ?? server.slug}
          </p>
          <McpServerHealthLine health={server.health} checking={testing} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {server.installId ? null : (
            <AvailabilityControl
              kind="mcpServer"
              id={server.id}
              availability={server.availability}
              onChanged={() => serversQuery.refetch()}
            />
          )}
          <AgentAccessControl
            bots={bots}
            access={accessOf(server)}
            disabled={!assignmentsReady}
            onChange={(access) => void setServerAgents(server, access)}
          />
          {signInFirst ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => void connectOAuth(server)}
            >
              {oauthActionLabel(server, pending)}
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label={t`Actions for ${server.name}`} />
              }
            >
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => startEditing(server)}>
                <Trans>Edit</Trans>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={testing || server.health.status === "installing"}
                onClick={() => void testServer(server)}
              >
                <Trans>Test connection</Trans>
              </DropdownMenuItem>
              {oauth && !signInFirst ? (
                <DropdownMenuItem disabled={pending} onClick={() => void connectOAuth(server)}>
                  {oauthActionLabel(server, pending)}
                </DropdownMenuItem>
              ) : null}
              {oauth && server.oauthStatus !== "none" ? (
                <DropdownMenuItem disabled={pending} onClick={() => void disconnectOAuth(server)}>
                  <Trans>Disconnect</Trans>
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setDeleting(server)}>
                <Trans>Delete</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </li>
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
        className="flex max-h-[calc(100%-2rem)] w-[600px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[600px]"
      >
        <DialogHeader className="flex-row items-center justify-between gap-3 border-b border-border px-6 py-5">
          <DialogTitle className="text-heading2 text-foreground">
            <Trans>MCP servers</Trans>
          </DialogTitle>
          <div className="flex items-center gap-1">
            {formOpen ? null : (
              <Button type="button" size="sm" onClick={() => setAdding(true)}>
                <Plus />
                <Trans>Add server</Trans>
              </Button>
            )}
            <DialogClose
              render={<Button variant="ghost" size="icon-sm" aria-label={t`Close MCP servers`} />}
            >
              <X />
            </DialogClose>
          </div>
        </DialogHeader>
        {shownError ? (
          <p
            role="alert"
            className="mx-6 mt-5 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
          >
            {shownError}
          </p>
        ) : null}
        <div className="rk-scroll min-h-0 overflow-y-auto px-6 py-5">
          {formOpen ? (
            renderForm()
          ) : (
            <ul className="-my-3 divide-y divide-border">{servers.map(renderServer)}</ul>
          )}
        </div>
        {deleting ? (
          <AlertDialog
            open
            onOpenChange={(open) => {
              if (!open) setDeleting(null);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {reachesOtherSpaces(deleting.availability, spaceCount) ? (
                    <Trans>Remove from every space?</Trans>
                  ) : (
                    t`Delete ${deleting.name}?`
                  )}
                </AlertDialogTitle>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  <Trans>Cancel</Trans>
                </AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => void deleteServer(deleting)}
                >
                  <Trans>Delete</Trans>
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
