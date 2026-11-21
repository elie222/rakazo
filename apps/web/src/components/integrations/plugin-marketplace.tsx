import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useLinkFavicon } from "@rakazo/chat-ui/web";
import type {
  BotMcpServer,
  CapabilityInstall,
  McpServer,
  PluginMarketplaceEntry,
  PluginPart,
  PluginPreview,
} from "@rakazo/contracts";
import { mcpServerConnection, mcpServerNeedsSignIn, PluginPreviewSchema } from "@rakazo/contracts";
import { installedPluginParts, pluginSite } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging/best-effort";
import {
  Button,
  Disclosure,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
  Switch,
  useCopyText,
} from "@rakazo/ui-web";
import { ArrowUpRight, Check, Ellipsis, FileText, Link2, Plug, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { connectMcpOauth } from "../../lib/integrations/mcp-connect";
import { desktopBridge } from "../../lib/platform/desktop";
import { rpc } from "../../lib/query/rpc";
import type { ErrorDetails } from "../../lib/query/user-error";
import { errorDetails, errorText } from "../../lib/query/user-error";
import { ErrorNotice } from "../ErrorNotice";
import { AvailabilityControl, reachesOtherSpaces, useOwnSpaces } from "./space-availability";

export type PluginSelection = {
  source: string;
  installedSource: string;
  name: string;
  description?: string;
  logo?: string | null;
  site?: string | null;
};

export function pluginSelection(entry: PluginMarketplaceEntry): PluginSelection {
  return {
    source: entry.source,
    installedSource: entry.installedSource,
    name: entry.displayName,
    description: entry.description,
    logo: entry.logo,
    site: pluginSite(entry),
  };
}

export function PluginLogo({
  name,
  logo,
  site,
  large = false,
}: {
  name: string;
  logo?: string | null;
  site?: string | null;
  large?: boolean;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  const useLogo = Boolean(logo) && !logoFailed;
  const favicon = useLinkFavicon(useLogo ? "" : (site ?? ""));
  const src = useLogo ? logo : favicon.icon;
  const box = large ? "h-14 w-14 rounded-2xl text-heading2" : "h-10 w-10 rounded-xl text-body";
  return src ? (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => (useLogo ? setLogoFailed(true) : favicon.unusable())}
      className={`${box} shrink-0 border border-border/60 bg-favicon-plate object-contain p-1.5`}
    />
  ) : (
    <div
      aria-hidden="true"
      className={`${box} grid shrink-0 place-items-center border border-border/60 bg-favicon-plate font-semibold text-foreground`}
    >
      {Array.from(name)[0]?.toUpperCase()}
    </div>
  );
}

/** A list row: icon, text and trailing actions on one line. */
export const ROW_SHELL = "flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2";

/** The row's main button, which fills the row up to its trailing actions. */
export const ROW_BUTTON =
  "flex min-w-0 flex-1 items-center gap-3 text-start focus-visible:outline-none";

/** The whole row highlights, including for keyboard focus on its main button. */
export const ROW_HOVER = "hover:bg-accent/60 has-[button:focus-visible]:bg-accent/60";

export function PluginRow({
  name,
  description,
  logo,
  site,
  installed,
  onOpen,
  onConnect,
}: {
  name: string;
  description: string;
  logo?: string | null;
  site?: string | null;
  installed: boolean;
  onOpen: () => void;
  /** Installs the connector and starts sign-in. Absent when the plugin has no connector. */
  onConnect?: () => void;
}) {
  const { t } = useLingui();
  return (
    <div data-testid="plugin-row" className={`${ROW_SHELL} ${ROW_HOVER}`}>
      <button type="button" onClick={onOpen} className={ROW_BUTTON}>
        <PluginLogo name={name} logo={logo} site={site} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body-lg font-medium text-foreground">{name}</span>
          {description ? (
            <span className="block truncate text-body-sm text-muted-foreground">{description}</span>
          ) : null}
        </span>
      </button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        aria-label={installed ? t`Added: ${name}` : onConnect ? undefined : t`Add ${name}`}
        onClick={() => (!installed && onConnect ? onConnect() : onOpen())}
      >
        {installed ? <Trans>Added</Trans> : onConnect ? <Trans>Connect</Trans> : <Trans>Add</Trans>}
      </Button>
    </div>
  );
}

/** A connected plugin's tools start on for every bot. An assignment can turn some off for one bot. */
function toolEnabled(assignment: BotMcpServer | undefined, name: string, allBots: boolean) {
  if (!allBots && !assignment) return false;
  if (!assignment || assignment.allowAllTools) return true;
  return assignment.allowedTools.includes(name);
}

function sourceHref(source: string, sha: string | undefined): string {
  const [repo = source, subdir] = source.split("#");
  return subdir ? `${repo}/tree/${sha ?? "HEAD"}/${subdir}` : repo;
}

const SKILLS_SHOWN = 5;

/** The managed app a plugin page connects instead of the plugin's own connector. */
export type ManagedAppLink = {
  name: string;
  logo: string | null;
  connected: boolean;
  connecting: boolean;
  onConnect: () => void;
  onManage: () => void;
};

export function PluginDetail({
  selection,
  installs,
  servers: allServers,
  assigned,
  activeBotId,
  managed: managedApp,
  skillsOnly = false,
  autoConnect = false,
  onBack,
  onChanged,
}: {
  selection: PluginSelection;
  installs: CapabilityInstall[];
  servers: McpServer[];
  assigned: Set<string>;
  activeBotId?: string;
  managed?: ManagedAppLink;
  /** Opened from Skills: only the plugin's skills are added here; its connector belongs to Integrations. */
  skillsOnly?: boolean;
  /** Install the connector, then start sign-in, the same as Connect followed by Sign in. */
  autoConnect?: boolean;
  onBack: () => void;
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useLingui();
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<ErrorDetails | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [recipe, setRecipe] = useState<{ name: string; content: string | null } | null>(null);
  const [allSkills, setAllSkills] = useState(false);
  const [noAuth, setNoAuth] = useState(new Set<string>());
  const [confirm, setConfirm] = useState<"disconnect" | "uninstall" | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolRows, setToolRows] = useState<
    | {
        serverId: string;
        name: string;
        description: string;
        enabled: boolean;
        locked: boolean;
      }[]
    | null
  >(null);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const toolsRequest = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const live = useRef(true);
  const spaceCount = useOwnSpaces().length;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // A pasted URL can differ from the normalized source the install is saved under.
  const install = installs.find(
    (row) =>
      row.kind === "plugin" &&
      (row.source === selection.installedSource || row.source === preview?.installedSource),
  );
  const parts = install ? installedPluginParts(install.config) : [];
  const servers =
    install && parts.includes("connector")
      ? allServers.filter((server) => server.installId === install.id)
      : [];
  const parsed = install ? PluginPreviewSchema.safeParse(install.config) : null;
  const detail = parsed?.success ? parsed.data : preview;
  const installed = Boolean(install);

  useEffect(() => {
    if (installed) return;
    let cancelled = false;
    setPreview(null);
    setError(null);
    setPreviewLoading(true);
    rpc.capabilities
      .pluginPreview({ source: selection.source })
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((err) => {
        if (!cancelled) setError(errorDetails(err, t`Could not preview plugin`));
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selection.source, installed, attempt]);

  async function run(key: string, action: () => Promise<unknown>, failure: string) {
    setPending(key);
    setError(null);
    try {
      await action();
    } catch (err) {
      if (live.current) setError(errorDetails(err, failure));
    } finally {
      if (live.current) setPending(null);
    }
  }

  /** The first part installs the plugin; later changes keep its pinned version. */
  const setParts = (key: string, next: PluginPart[], failure: string) =>
    run(
      key,
      async () => {
        if (install) await rpc.capabilities.pluginParts({ id: install.id, parts: next });
        else if (preview)
          await rpc.capabilities.install({
            kind: "plugin",
            name: preview.name,
            source: preview.pinnedSource ?? selection.source,
            pluginDigest: preview.digest,
            config: {},
            pluginParts: next,
          });
        setConfirmRemove(false);
        await onChanged();
      },
      failure,
    );
  const toggle = (part: PluginPart, on: boolean) =>
    on
      ? [...parts.filter((value) => value !== part), part]
      : parts.filter((value) => value !== part);

  const signIn = (server: McpServer) =>
    run(
      server.id,
      async () => {
        const result = await connectMcpOauth(server.id);
        if (!live.current) return;
        if (result === "authorization_not_requested")
          setNoAuth((current) => new Set([...current, server.id]));
        if (result === "cancelled") setError(errorDetails(t`Sign-in cancelled. Try again.`));
        await onChanged();
      },
      t`Could not sign in`,
    );

  const enable = (server: McpServer) =>
    activeBotId &&
    run(
      server.id,
      async () => {
        await rpc.mcp.assignments.approve({ botId: activeBotId, serverId: server.id });
        await onChanged();
      },
      t`Could not enable tools`,
    );

  // A plugin connector already installed stays manageable here until it is removed.
  const managed = parts.includes("connector") ? undefined : managedApp;
  // Installed plugin skills are read-only, so their saved instructions open in place.
  async function toggleRecipe(name: string) {
    if (recipe?.name === name) return setRecipe(null);
    setRecipe({ name, content: null });
    try {
      const entry = (await rpc.agentSkills.list()).find(
        (row) => row.source === "plugin" && row.name.toLowerCase() === name.toLowerCase(),
      );
      if (!entry) throw new Error(t`Could not load skill`);
      const skill = await rpc.agentSkills.get({ skillId: entry.id });
      if (live.current)
        setRecipe((open) => (open?.name === name ? { name, content: skill.content } : open));
    } catch (err) {
      if (live.current) {
        setRecipe(null);
        setError(errorDetails(err, t`Could not load skill`));
      }
    }
  }

  // An ignored manifest field loses nothing, so it isn't reported. A skill left out for repeating
  // a built-in one says why, since the user still has that skill.
  const notAdded = [
    ...(detail?.skipped ?? [])
      .filter((entry) => entry.kind !== "unsupported_field")
      .map((entry) => entry.name),
    ...(detail?.builtinNames ?? []).map((name) => t`${name} (same name as a built-in skill)`),
  ];
  const prefix = `${detail?.name ?? ""}: `;
  const skills = detail?.skills ?? [];
  const shownSkills = allSkills ? skills : skills.slice(0, SKILLS_SHOWN);
  const connectorCount = detail?.mcpServers.length ?? 0;
  // Without a connector there is nothing to connect, so the page adds the skills instead.
  const skillPack = skillsOnly || (!managed && !connectorCount && Boolean(detail));
  const headerPart: PluginPart = skillPack ? "skills" : "connector";
  const headerOn = parts.includes(headerPart);
  const skillsOn = parts.includes("skills");
  const busy = Boolean(pending);
  const everywhere = reachesOtherSpaces(install?.availability, spaceCount);
  const ready = Boolean(detail) && (Boolean(install) || Boolean(preview));
  const pluginConnected =
    servers.length > 0 &&
    servers.every((server) => mcpServerConnection(server) === "connected" || noAuth.has(server.id));
  const connectorPlugin = !skillPack && !managed && (connectorCount > 0 || servers.length > 0);
  // A plugin is one install for the account. All spaces, the default, includes an
  // organization created later. availability omitted means that default.
  const allSpaces = install?.availability?.allSpaces !== false;
  const installedConnector = useRef(false);
  const startedSignIn = useRef(false);
  useEffect(() => {
    if (!autoConnect || skillsOnly || busy || !ready) return;
    let cancelled = false;
    // Wait a microtask so React's development remount cancels the first pass.
    queueMicrotask(() => {
      if (cancelled) return;
      if (managed) {
        if (!installedConnector.current && !managed.connected && !managed.connecting) {
          installedConnector.current = true;
          managed.onConnect();
        }
        return;
      }
      if (!install) {
        if (installedConnector.current || !preview || skillPack) return;
        installedConnector.current = true;
        void setParts("header", ["connector"], t`Could not install plugin`);
        return;
      }
      if (!parts.includes("connector")) {
        if (installedConnector.current) return;
        installedConnector.current = true;
        void setParts("header", toggle("connector", true), t`Could not install plugin`);
        return;
      }
      if (startedSignIn.current) return;
      const server = servers.find(
        (row) => mcpServerNeedsSignIn(row) && mcpServerConnection(row) !== "needs_client",
      );
      if (!servers.length) return;
      startedSignIn.current = true;
      if (server) void signIn(server);
    });
    return () => {
      cancelled = true;
    };
  }, [
    autoConnect,
    skillsOnly,
    busy,
    ready,
    managed,
    install,
    preview,
    skillPack,
    parts,
    servers,
    setParts,
    signIn,
    t,
  ]);

  const spaceNote = !connectorPlugin
    ? null
    : !install
      ? t`Connecting adds one plugin for your account. It then shows in every space, including an organization you create later.`
      : allSpaces
        ? t`This plugin is one install for your account. It is in every space, including an organization you create later. Disconnect deletes its MCP server and removes it from all of them.`
        : t`This plugin is only in the spaces you chose. Disconnect deletes its MCP server and removes it from those spaces.`;

  const [copied, copy] = useCopyText();
  async function share() {
    const href = sourceHref(selection.installedSource, detail?.resolvedSha);
    if (await copy(href)) return;
    window.open(href, "_blank", "noopener,noreferrer");
  }

  function startSignIn() {
    const server = servers.find(
      (row) => mcpServerNeedsSignIn(row) && mcpServerConnection(row) !== "needs_client",
    );
    if (server) void signIn(server);
    else if (servers[0]) void signIn(servers[0]);
  }

  async function loadTools() {
    const request = ++toolsRequest.current;
    setToolsLoading(true);
    setToolsError(null);
    try {
      const [listed, assignments] = await Promise.all([
        Promise.all(
          servers.map(async (server) => ({
            server,
            tools: await rpc.mcp.servers.tools({ id: server.id }),
          })),
        ),
        activeBotId ? rpc.mcp.assignments.list({ botId: activeBotId }) : Promise.resolve([]),
      ]);
      if (request !== toolsRequest.current || !live.current) return;
      const byServer = new Map(assignments.map((row) => [row.serverId, row]));
      setToolRows(
        listed.flatMap(({ server, tools }) =>
          tools.map((tool) => {
            const assignment = byServer.get(server.id);
            const locked = server.allBots !== true && !assignment;
            return {
              serverId: server.id,
              name: tool.name,
              description: tool.description,
              enabled: toolEnabled(assignment, tool.name, server.allBots ?? false),
              locked,
            };
          }),
        ),
      );
    } catch (err) {
      if (request === toolsRequest.current && live.current)
        setToolsError(errorText(err, t`Could not list tools`));
    } finally {
      if (request === toolsRequest.current && live.current) setToolsLoading(false);
    }
  }

  function toggleTool(serverId: string, name: string, enabled: boolean) {
    if (!activeBotId || !toolRows) return;
    if (toolRows.some((row) => row.serverId === serverId && row.locked)) return;
    const serverTools = toolRows.filter((row) => row.serverId === serverId);
    const enabledNames = serverTools
      .filter((row) => (row.name === name ? enabled : row.enabled))
      .map((row) => row.name);
    const allowAllTools = enabledNames.length === serverTools.length;
    const previous = toolRows;
    setToolRows(
      toolRows.map((row) =>
        row.serverId === serverId && row.name === name ? { ...row, enabled } : row,
      ),
    );
    void run(
      `tool:${serverId}:${name}`,
      async () => {
        try {
          await rpc.mcp.assignments.setTools({
            botId: activeBotId,
            serverId,
            allowAllTools,
            allowedTools: allowAllTools ? [] : enabledNames,
          });
          await onChanged();
        } catch (err) {
          if (live.current) setToolRows(previous);
          throw err;
        }
      },
      t`Could not update tools`,
    );
  }

  /** Deletes the MCP servers with the plugin. One install, so every space loses it. */
  function removePlugin() {
    if (!install) return;
    void run(
      "remove",
      async () => {
        const browser = desktopBridge()?.mcpBrowser;
        await Promise.all(
          servers.map((server) =>
            bestEffort("clear the desktop MCP browser", browser?.clear(server.id)),
          ),
        );
        await rpc.capabilities.remove({ id: install.id });
        setConfirm(null);
        await onChanged();
        onBack();
      },
      t`Could not remove plugin`,
    );
  }

  function headerAction() {
    if (confirm && install) {
      return (
        <>
          <Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button variant="destructive" disabled={busy} onClick={removePlugin}>
            {pending === "remove" ? (
              <Trans>Removing…</Trans>
            ) : confirm === "disconnect" ? (
              <Trans>Disconnect</Trans>
            ) : (
              <Trans>Uninstall</Trans>
            )}
          </Button>
        </>
      );
    }
    if (connectorPlugin && pluginConnected) {
      return (
        <>
          <Button variant="secondary" disabled={busy} onClick={startSignIn}>
            <Trans>Reconnect</Trans>
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => setConfirm("disconnect")}>
            <Trans>Disconnect</Trans>
          </Button>
        </>
      );
    }
    if (connectorPlugin && (installed || !install)) {
      const reconnect = servers.some(
        (row) => row.oauthStatus === "reconnect" || row.oauthStatus === "connected",
      );
      // A disabled server stays off. Every other unconnected plugin still offers Connect.
      const offerConnect =
        !installed ||
        servers.length === 0 ||
        servers.some((row) => mcpServerConnection(row) !== "disabled");
      return (
        <>
          {detail ? (
            <Button variant="secondary" disabled={busy} onClick={() => void share()}>
              {copied ? <Check /> : <Link2 />}
              {copied ? <Trans>Copied</Trans> : <Trans>Share</Trans>}
            </Button>
          ) : null}
          {offerConnect && !installed ? (
            <Button
              disabled={busy || !ready}
              onClick={() =>
                void setParts("header", toggle(headerPart, true), t`Could not install plugin`)
              }
            >
              {pending === "header" ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
            </Button>
          ) : null}
          {offerConnect && installed ? (
            <Button
              disabled={busy}
              onClick={() => {
                if (!parts.includes("connector")) {
                  void setParts("header", toggle("connector", true), t`Could not install plugin`);
                  return;
                }
                startSignIn();
              }}
            >
              {pending && pending !== "remove" ? (
                <Trans>Connecting…</Trans>
              ) : reconnect ? (
                <Trans>Reconnect</Trans>
              ) : (
                <Trans>Connect</Trans>
              )}
            </Button>
          ) : null}
          {installed ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    aria-label={t`More`}
                    disabled={busy}
                  />
                }
              >
                <Ellipsis />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onClick={() => setConfirm("uninstall")}>
                  <Trash2 />
                  <Trans>Uninstall</Trans>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </>
      );
    }
    if (managed)
      return managed.connected ? (
        <Button variant="secondary" disabled={busy} onClick={managed.onManage}>
          <Trans>Added</Trans>
        </Button>
      ) : (
        <Button
          size="lg"
          className="px-5"
          disabled={busy || managed.connecting}
          onClick={managed.onConnect}
        >
          {managed.connecting ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
        </Button>
      );
    if (headerOn)
      return confirmRemove ? (
        <>
          <Button variant="ghost" disabled={busy} onClick={() => setConfirmRemove(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() =>
              void setParts("header", toggle(headerPart, false), t`Could not remove plugin`)
            }
          >
            {pending === "header" ? (
              <Trans>Removing…</Trans>
            ) : everywhere ? (
              <Trans>Remove from every space?</Trans>
            ) : (
              <Trans>Confirm removal</Trans>
            )}
          </Button>
        </>
      ) : (
        <Button variant="secondary" disabled={busy} onClick={() => setConfirmRemove(true)}>
          <Trans>Remove</Trans>
        </Button>
      );
    return (
      <Button
        size="lg"
        className="px-5"
        disabled={busy || !ready}
        onClick={() =>
          void setParts("header", toggle(headerPart, true), t`Could not install plugin`)
        }
      >
        {pending === "header" ? (
          skillPack ? (
            <Trans>Adding…</Trans>
          ) : (
            <Trans>Connecting…</Trans>
          )
        ) : skillPack ? (
          <Trans>Add</Trans>
        ) : (
          <Trans>Connect</Trans>
        )}
      </Button>
    );
  }

  return (
    <div data-testid="plugin-detail" className="space-y-7">
      <div className="flex items-start gap-4">
        <PluginLogo
          name={selection.name}
          logo={managed?.logo ?? selection.logo}
          site={selection.site}
          large
        />
        <div className="min-w-0 flex-1 pt-1">
          <h2 className="truncate text-heading2 font-semibold text-foreground">
            {managed?.name ?? selection.name}
          </h2>
          <a
            href={sourceHref(selection.installedSource, detail?.resolvedSha)}
            target="_blank"
            rel="noreferrer"
            title={detail ? `${selection.installedSource}@${detail.resolvedSha}` : undefined}
            className="inline-flex items-center gap-1 text-body text-muted-foreground hover:text-foreground"
          >
            <Trans>View source</Trans>
            <ArrowUpRight size={14} />
          </a>
        </div>
        <div className="flex shrink-0 gap-2 pt-2">{headerAction()}</div>
      </div>

      {detail?.description || selection.description ? (
        <p className="text-body-lg leading-6 text-muted-foreground">
          {detail?.description || selection.description}
        </p>
      ) : null}

      {install ? (
        <AvailabilityControl
          kind="install"
          id={install.id}
          availability={install.availability}
          onChanged={onChanged}
        />
      ) : null}

      {error ? (
        <ErrorNotice error={error}>
          {!installed && !preview && !previewLoading ? (
            <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
              <Trans>Retry</Trans>
            </Button>
          ) : null}
        </ErrorNotice>
      ) : null}

      {previewLoading ? (
        <div className="grid place-items-center py-10">
          <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
        </div>
      ) : null}

      {spaceNote ? (
        <p data-testid="plugin-space-note" className="px-1 text-body-sm text-muted-foreground">
          {spaceNote}
        </p>
      ) : null}

      {connectorPlugin && servers.length ? (
        <section data-testid="plugin-accounts">
          <h3 className="mb-2 px-1 text-body font-medium text-foreground">
            <Trans>Accounts</Trans>
          </h3>
          <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
            {servers.map((server) => (
              <li key={server.id} className="flex items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1 truncate text-body-lg font-medium">
                  {server.name.startsWith(prefix) ? server.name.slice(prefix.length) : server.name}
                </span>
                {mcpServerConnection(server) === "connected" || noAuth.has(server.id) ? (
                  <span className="shrink-0 text-body-sm font-medium text-success">
                    <Trans>Connected</Trans>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {pluginConnected ? (
        <section data-testid="plugin-tools">
          <h3 className="mb-2 px-1 text-body font-medium text-foreground">
            <Trans>Tools</Trans>
          </h3>
          <Disclosure
            className="rounded-xl border border-border/70"
            summaryClassName="w-full justify-between px-4 py-3 text-body text-muted-foreground"
            open={toolsOpen}
            onOpenChange={(open) => {
              setToolsOpen(open);
              if (open && !toolRows && !toolsLoading) void loadTools();
            }}
            summary={
              servers.some((server) => server.health.toolCount != null) || toolRows ? (
                <Plural
                  value={
                    toolRows?.length ??
                    servers.reduce((sum, server) => sum + (server.health.toolCount ?? 0), 0)
                  }
                  one="# tool"
                  other="# tools"
                />
              ) : (
                <Trans>Connected</Trans>
              )
            }
          >
            {toolsLoading ? (
              <div className="grid place-items-center py-4">
                <Spinner className="size-4 text-muted-foreground" aria-label={t`Loading…`} />
              </div>
            ) : null}
            {toolsError ? (
              <p className="px-4 py-3 text-body-sm text-destructive">{toolsError}</p>
            ) : null}
            {toolRows ? (
              <ul className="border-t border-border/60">
                {toolRows.map((tool) => (
                  <li
                    key={`${tool.serverId}:${tool.name}`}
                    className="flex items-center gap-3 px-4 py-2.5"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body text-foreground">{tool.name}</span>
                      {tool.description ? (
                        <span className="block truncate text-body-sm text-muted-foreground">
                          {tool.description}
                        </span>
                      ) : null}
                    </span>
                    <Switch
                      size="sm"
                      checked={tool.enabled}
                      disabled={!activeBotId || busy || tool.locked}
                      aria-label={t`Enable ${tool.name}`}
                      onCheckedChange={(checked) => toggleTool(tool.serverId, tool.name, checked)}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </Disclosure>
        </section>
      ) : null}

      {!skillsOnly && (managed || connectorCount) ? (
        <section>
          <h3 className="mb-2 flex gap-2 px-1 text-body font-medium text-foreground">
            <Trans>Apps</Trans>
            <span className="text-muted-foreground">{managed ? 1 : connectorCount}</span>
          </h3>
          <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
            {managed ? (
              <li className="flex items-center gap-3 px-4 py-3">
                <Plug size={16} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-lg font-medium">{managed.name}</span>
                  <span className="block truncate text-body-sm text-muted-foreground">
                    <Trans>Connector</Trans>
                  </span>
                </span>
                {managed.connected ? (
                  <Check role="img" aria-label={t`Connected`} className="size-4 text-success" />
                ) : null}
              </li>
            ) : servers.length ? (
              servers.map((server) => (
                <li
                  key={server.id}
                  aria-label={server.name}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <Plug size={16} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-lg font-medium">
                      {server.name.startsWith(prefix)
                        ? server.name.slice(prefix.length)
                        : server.name}
                    </span>
                    <span className="block truncate text-body-sm text-muted-foreground">
                      {server.endpoint}
                    </span>
                  </span>
                  {mcpServerConnection(server) === "connected" || noAuth.has(server.id) ? (
                    <span className="shrink-0 text-body-sm font-medium text-success">
                      <Check role="img" aria-label={t`Connected`} className="size-4" />
                    </span>
                  ) : null}
                  {activeBotId ? (
                    assigned.has(server.id) ? (
                      <span className="text-body-sm text-muted-foreground">
                        <Trans>In this bot</Trans>
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void enable(server)}
                      >
                        <Trans>Use in this bot</Trans>
                      </Button>
                    )
                  ) : null}
                </li>
              ))
            ) : (
              detail?.mcpServers.map((server) => (
                <li key={server.name} className="flex items-center gap-3 px-4 py-3">
                  <Plug size={16} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-lg font-medium">{server.name}</span>
                    <span className="block truncate text-body-sm text-muted-foreground">
                      {server.endpoint}
                    </span>
                  </span>
                </li>
              ))
            )}
          </ul>
        </section>
      ) : null}

      {skills.length ? (
        <section data-testid="plugin-skills">
          <div className="mb-2 flex items-center justify-between gap-3 px-1">
            <h3 className="flex gap-2 text-body font-medium text-foreground">
              <Trans>Skills</Trans>
              <span className="text-muted-foreground">{skills.length}</span>
            </h3>
            {skillPack ? null : (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || !ready}
                onClick={() =>
                  void setParts(
                    "skills",
                    toggle("skills", !skillsOn),
                    skillsOn ? t`Could not remove skills` : t`Could not add skills`,
                  )
                }
              >
                {pending === "skills" ? (
                  skillsOn ? (
                    <Trans>Removing…</Trans>
                  ) : (
                    <Trans>Adding…</Trans>
                  )
                ) : skillsOn ? (
                  <Trans>Remove skills</Trans>
                ) : (
                  <Trans>Add skills</Trans>
                )}
              </Button>
            )}
          </div>
          <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
            {shownSkills.map((skill) => {
              const row = (
                <>
                  <FileText size={16} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-lg font-medium">{skill.name}</span>
                    <span className="block truncate text-body-sm text-muted-foreground">
                      {skill.description}
                    </span>
                  </span>
                  {skill.files?.length ? (
                    <span
                      className="shrink-0 text-body-sm text-muted-foreground"
                      title={skill.files.join("\n")}
                    >
                      <Plural value={skill.files.length} one="# file" other="# files" />
                    </span>
                  ) : null}
                </>
              );
              return (
                <li key={skill.name}>
                  {skillsOn ? (
                    <button
                      type="button"
                      aria-expanded={recipe?.name === skill.name}
                      className="flex w-full items-center gap-3 px-4 py-3 text-start hover:bg-accent/60"
                      onClick={() => void toggleRecipe(skill.name)}
                    >
                      {row}
                    </button>
                  ) : (
                    <div className="flex items-center gap-3 px-4 py-3">{row}</div>
                  )}
                  {recipe?.name === skill.name ? (
                    <pre
                      data-testid="plugin-skill-recipe"
                      className="max-h-80 overflow-auto whitespace-pre-wrap border-t border-border/60 px-4 py-3 font-mono text-body-sm text-foreground"
                      dir="auto"
                    >
                      {recipe.content ?? <Spinner className="size-4 text-muted-foreground" />}
                    </pre>
                  ) : null}
                </li>
              );
            })}
            {skills.length > shownSkills.length ? (
              <li className="flex justify-end px-2 py-1.5">
                <Button variant="text" size="sm" onClick={() => setAllSkills(true)}>
                  <Plural value={skills.length - shownSkills.length} one="# more" other="# more" />
                </Button>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      {detail && connectorPlugin ? (
        <section data-testid="plugin-information" className="space-y-2">
          <h3 className="px-1 text-body font-medium text-foreground">
            <Trans>Information</Trans>
          </h3>
          <dl className="divide-y divide-border/60 rounded-xl border border-border/70">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <dt className="text-body text-muted-foreground">
                <Trans>Capabilities</Trans>
              </dt>
              <dd className="text-body text-foreground">
                <Plural value={connectorCount || servers.length} one="# app" other="# apps" />
                {skills.length ? (
                  <>
                    {", "}
                    <Plural value={skills.length} one="# skill" other="# skills" />
                  </>
                ) : null}
              </dd>
            </div>
            {detail.author ? (
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <dt className="text-body text-muted-foreground">
                  <Trans>Developer</Trans>
                </dt>
                <dd className="truncate text-body text-foreground">{detail.author}</dd>
              </div>
            ) : null}
            {detail.homepage || selection.site ? (
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <dt className="text-body text-muted-foreground">
                  <Trans>Website</Trans>
                </dt>
                <dd className="truncate text-body text-foreground">
                  {detail.homepage || selection.site}
                </dd>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <dt className="text-body text-muted-foreground">
                <Trans>Availability</Trans>
              </dt>
              <dd className="text-body text-foreground">
                {install ? (
                  allSpaces ? (
                    <Trans>All spaces</Trans>
                  ) : (
                    <Trans>Chosen spaces</Trans>
                  )
                ) : (
                  <Trans>All spaces</Trans>
                )}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}

      {notAdded.length ? (
        <p className="px-1 text-body-sm text-muted-foreground">
          <Trans>Not added: {notAdded.join(", ")}</Trans>
        </p>
      ) : null}
    </div>
  );
}
