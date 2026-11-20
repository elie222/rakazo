import { Plural, Trans } from "@lingui/react/macro";
import type { CapabilityInstall, ConnectionCatalogItem, McpServer } from "@rakazo/contracts";
import { mcpServerConnection, mcpServerNeedsSignIn } from "@rakazo/contracts";
import { catalogItemKey, installedPluginParts } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import type { PluginSelection } from "../../components/integrations/plugin-marketplace";
import { PluginLogo, ROW_BUTTON, ROW_HOVER } from "../../components/integrations/plugin-marketplace";
import {
  AvailabilityControl,
  AvailabilityLabel,
} from "../../components/integrations/space-availability";
import { ConnectionStatus, ConnectorIcon } from "./parts";
import type { PluginConnections } from "./use-plugin-connections";

/** Installed apps: connected catalog apps, plugins, MCP servers, and custom tool sources. */
export function ManageView({
  state,
  connectedItems,
  connectorInstalls,
  standaloneServers,
  appCount,
  sourceError,
  confirmingSource,
  onRemoveSource,
  onOpenMcp,
  installedSelection,
  pluginServers,
  onOpenPlugin,
  onOpenApp,
}: {
  state: PluginConnections;
  connectedItems: ConnectionCatalogItem[];
  connectorInstalls: CapabilityInstall[];
  standaloneServers: McpServer[];
  appCount: number;
  sourceError: string | null;
  /** The source whose removal asks again because it reaches other spaces. */
  confirmingSource: string | null;
  onRemoveSource: (install: CapabilityInstall) => void;
  onOpenMcp?: () => void;
  installedSelection: (install: CapabilityInstall) => PluginSelection;
  pluginServers: (install: CapabilityInstall | undefined) => McpServer[];
  onOpenPlugin: (selection: PluginSelection) => void;
  onOpenApp: (item: ConnectionCatalogItem) => void;
}) {
  const { mcpError, mcpQuery, sources, pending, refresh } = state;
  const appPlugins = connectorInstalls;
  const pluginNames = new Set(
    appPlugins.map((install) => installedSelection(install).name.trim().toLowerCase()),
  );
  const catalogApps = connectedItems.filter(
    (item) => !pluginNames.has(item.name.trim().toLowerCase()),
  );
  const hasApps = appCount > 0 || Boolean(mcpError);
  return (
    <div data-testid="integrations-manage" className="space-y-6">
      <h2 className="text-heading3 font-normal text-foreground">
        <Trans>Manage plugins and skills</Trans>
      </h2>

      {hasApps ? (
        <section data-testid="connected-apps">
          {onOpenMcp && standaloneServers.length ? (
            <div className="mb-2 flex justify-end">
              <Button variant="link" size="xs" onClick={onOpenMcp}>
                <Trans>Manage MCP servers</Trans>
              </Button>
            </div>
          ) : null}
          {mcpError ? (
            <div
              role="alert"
              className="mb-2 flex items-center gap-2 px-2.5 text-body text-destructive"
            >
              {mcpError}
              <Button variant="link" size="xs" onClick={() => void mcpQuery.refetch()}>
                <Trans>Retry</Trans>
              </Button>
            </div>
          ) : null}
          {sourceError ? (
            <p role="alert" className="mb-2 px-2.5 text-body text-destructive">
              {sourceError}
            </p>
          ) : null}
          <p className="mb-2 text-body-sm text-muted-foreground">
            <Trans>Installed</Trans>
          </p>
          <div className="grid grid-cols-1 items-start gap-x-8 gap-y-1 sm:grid-cols-2">
            {catalogApps.map((item) => (
              <InstalledCatalogRow
                key={catalogItemKey(item)}
                item={item}
                onOpen={() => onOpenApp(item)}
              />
            ))}
            {appPlugins.map((install) => (
              <InstalledPluginRow
                key={`${install.id}:connector`}
                install={install}
                selection={installedSelection(install)}
                servers={pluginServers(install)}
                onOpen={onOpenPlugin}
              />
            ))}
            <div data-testid="registered-mcp-servers" className="contents">
              {standaloneServers.map((server) => (
                <div
                  key={server.id}
                  data-testid="registered-mcp-server"
                  className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2"
                >
                  <ConnectorIcon name={server.name} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-lg font-medium">{server.name}</span>
                    <ConnectionStatus server={server} />
                  </span>
                  <AvailabilityLabel availability={server.availability} />
                </div>
              ))}
            </div>
            <div data-testid="tool-sources" className="contents">
              {sources.map((source) => (
                <ToolSourceRow
                  key={source.id}
                  source={source}
                  confirming={confirmingSource === source.id}
                  removing={pending === source.id}
                  onRemove={onRemoveSource}
                  refresh={refresh}
                />
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function ToolSourceRow({
  source,
  confirming,
  removing,
  onRemove,
  refresh,
}: {
  source: CapabilityInstall;
  confirming: boolean;
  removing: boolean;
  onRemove: (install: CapabilityInstall) => void;
  refresh: PluginConnections["refresh"];
}) {
  // Ties the Remove button to its source name, so identical buttons tell apart for screen readers.
  const nameId = useId();
  return (
    <div
      data-testid="tool-source"
      className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2"
    >
      <ConnectorIcon name={source.name} />
      <span className="min-w-0 flex-1">
        <span id={nameId} className="block truncate text-body-lg font-medium">
          {source.name}
        </span>
        <span className="block truncate text-body-sm text-muted-foreground">
          {source.kind === "api" ? "OpenAPI" : source.kind === "graphql" ? "GraphQL" : "MCP"}{" "}
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
        variant={confirming ? "destructive" : "secondary"}
        size="sm"
        aria-describedby={nameId}
        disabled={removing}
        onClick={() => onRemove(source)}
      >
        {removing ? (
          <Trans>Removing…</Trans>
        ) : confirming ? (
          <Trans>Remove from every space?</Trans>
        ) : (
          <Trans>Remove</Trans>
        )}
      </Button>
    </div>
  );
}

function InstalledCatalogRow({
  item,
  onOpen,
}: {
  item: ConnectionCatalogItem;
  onOpen: () => void;
}) {
  return (
    <div className={`flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2 ${ROW_HOVER}`}>
      <button type="button" className={ROW_BUTTON} onClick={onOpen}>
        <ConnectorIcon name={item.name} logo={item.logo} />
        <span className="min-w-0 flex-1 text-start">
          <span className="block truncate text-body-lg font-medium">{item.name}</span>
          <span className="block truncate text-body-sm text-muted-foreground">
            <Trans>1 connector</Trans>
          </span>
        </span>
      </button>
      <span className="shrink-0 text-body-sm font-medium text-success">
        <Trans>Connected</Trans>
      </span>
    </div>
  );
}

function InstalledPluginRow({
  install,
  selection,
  servers,
  onOpen,
}: {
  install: CapabilityInstall;
  selection: PluginSelection;
  servers: McpServer[];
  onOpen: (selection: PluginSelection) => void;
}) {
  const signInNeeded = servers.some(mcpServerNeedsSignIn);
  const connected =
    servers.length > 0 &&
    servers.every((server) => mcpServerConnection(server) === "connected");
  const attention =
    servers.find((server) => mcpServerConnection(server) === "needs_client") ??
    servers.find((server) => {
      const state = mcpServerConnection(server);
      return state !== "connected" && state !== "not_connected";
    });
  const connectors =
    servers.length || (installedPluginParts(install.config).includes("connector") ? 1 : 0);
  const skills = Array.isArray(install.config.skills) ? install.config.skills.length : 0;
  return (
    <div data-testid="installed-plugin" className="min-w-0">
      <div className={`flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2 ${ROW_HOVER}`}>
        <PluginLogo name={selection.name} logo={selection.logo} site={selection.site} />
        <button
          type="button"
          className="block min-w-0 flex-1 text-start"
          onClick={() => onOpen(selection)}
        >
          <span className="block truncate text-body-lg font-medium">{selection.name}</span>
          <span className="block truncate text-body-sm text-muted-foreground">
            <Plural value={connectors} one="# connector" other="# connectors" />
            {skills > 0 ? (
              <>
                {", "}
                <Plural value={skills} one="# skill" other="# skills" />
              </>
            ) : null}
          </span>
        </button>
        {connected && !signInNeeded ? (
          <span className="shrink-0 text-body-sm font-medium text-success">
            <Trans>Connected</Trans>
          </span>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={() => onOpen(selection)}
          >
            <Trans>Connect</Trans>
          </Button>
        )}
      </div>
      {attention ? <ServerNotice server={attention} /> : null}
    </div>
  );
}

function ServerNotice({ server }: { server: McpServer }) {
  const [open, setOpen] = useState(false);
  const detail = server.health.message?.trim();
  return (
    <div className="flex gap-3 px-2.5 pt-1">
      <span className="w-10 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        {detail ? (
          <button
            type="button"
            className="flex max-w-full items-center gap-1 rounded-md text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            <ConnectionStatus server={server} />
            <ChevronDown
              aria-hidden="true"
              className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
            />
          </button>
        ) : (
          <ConnectionStatus server={server} />
        )}
        {open && detail ? (
          <p className="mt-1 text-body-sm text-muted-foreground">{detail}</p>
        ) : null}
      </div>
    </div>
  );
}
