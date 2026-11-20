import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useLinkFavicon } from "@rakazo/chat-ui/web";
import type {
  CapabilityInstall,
  ConnectionCatalogItem,
  IntegrationCatalogResult,
  IntegrationCatalogSurface,
  McpSourcePreset,
} from "@rakazo/contracts";
import { MCP_OAUTH_CLIENT_REQUIRED } from "@rakazo/contracts";
import type { connectedAppMarks } from "@rakazo/core";
import {
  CONNECTION_CATALOG_PAGE_SIZE,
  catalogItemKey,
  customMcpServerInput,
  installedPluginParts,
  managedAppFor,
  pluginSite,
} from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  LogoAvatar,
  Spinner,
} from "@rakazo/ui-web";
import { ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { IntegrationSetup } from "../../components/integrations/IntegrationSetup";
import type {
  ManagedAppLink,
  PluginSelection,
} from "../../components/integrations/plugin-marketplace";
import { PluginDetail, pluginSelection } from "../../components/integrations/plugin-marketplace";
import { reachesOtherSpaces, useOwnSpaces } from "../../components/integrations/space-availability";
import { connectMcpOauth } from "../../lib/integrations/mcp-connect";
import { rpc } from "../../lib/query/rpc";
import { errorCode, errorText } from "../../lib/query/user-error";
import { AddMenu } from "./add-menu";
import { ConnectorDetail } from "./connector-detail";
import { DomainSearch, useDomainSearch } from "./domain-search";
import { GithubImport } from "./github-import";
import { ManageView } from "./manage-view";
import type { TileContext } from "./parts";
import { ViewTitle } from "./parts";
import { PluginBrowse } from "./plugin-browse";
import type { SourceKind } from "./source-form";
import { SourceFormView, useSourceForm } from "./source-form";
import { PLUGIN_PAGE_SIZE, useCatalogBrowse } from "./use-catalog-browse";
import { usePluginConnections } from "./use-plugin-connections";

type OverlayView = "browse" | "manage" | "github" | "source" | "browseMcp" | "domain";

const CHIP_COUNT = 6;

/** One added app in the header cluster, using the same site icon as its row. */
function AddedMark({
  name,
  logo,
  site,
}: {
  name: string;
  logo?: string | null;
  site?: string | null;
}) {
  const favicon = useLinkFavicon(logo ? "" : (site ?? ""));
  const src = logo || favicon.icon;
  return src ? (
    <img src={src} alt="" className="size-6 rounded-md bg-white object-cover" />
  ) : (
    <span className="grid size-6 place-items-center rounded-md bg-white text-caption font-semibold text-foreground">
      {Array.from(name)[0]?.toUpperCase()}
    </span>
  );
}

export function PluginsOverlay({
  onConnectedAppsChange,
  onClose,
  onOpenMcp,
  onOpenTemplates,
  onOpenMessaging,
  activeBotId,
}: {
  onConnectedAppsChange?: (apps: ReturnType<typeof connectedAppMarks>) => void;
  onClose: () => void;
  onOpenMcp?: () => void;
  onOpenTemplates?: () => void;
  onOpenMessaging?: () => void;
  activeBotId?: string;
}) {
  const { t } = useLingui();
  const [confirmingSource, setConfirmingSource] = useState<string | null>(null);
  const spaceCount = useOwnSpaces().length;
  const [sourceError, setSourceError] = useState<string | null>(null);
  const sourceAction = useRef(0);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [view, setView] = useState<OverlayView>("browse");
  const [publicCatalogQuery, setPublicCatalogQuery] = useState("");
  // Where a source form returns: the domain search that prefilled it, or browse.
  const [sourceBack, setSourceBack] = useState<OverlayView>("browse");
  const [plugin, setPlugin] = useState<PluginSelection | null>(null);
  const [pluginAutoConnect, setPluginAutoConnect] = useState(false);
  const [gitSource, setGitSource] = useState("");
  const [detailKey, setDetailKey] = useState<{
    connectorId: string;
    slug: string;
  } | null>(null);
  const state = usePluginConnections({
    activeBotId,
    detailKey,
    closeDetail,
    onConnectedAppsChange,
  });
  const {
    mcpServers,
    sourcePresets,
    integrations,
    catalogLoaded,
    loading,
    catalog,
    sources,
    pluginInstalls,
    assigned,
    catalogFeedEnabled,
    loadError,
    updateIntegrations,
    refresh,
    pending,
    setPending,
    catalogError,
    setCatalogError,
    itemConnected,
    connect,
  } = state;
  const browse = useCatalogBrowse({
    catalog,
    catalogLoaded,
    loadError,
    pluginCatalog: state.pluginCatalog,
  });
  const {
    query,
    setQuery,
    setVisibleCount,
    category,
    setCategory,
    setPluginCount,
    catalogEntries,
    pluginForApp,
    categoryLabel,
    categories,
  } = browse;
  const sourceForm = useSourceForm();
  const domainSearch = useDomainSearch();

  const detailItem = useMemo(() => {
    if (!detailKey) return null;
    return (
      catalog.find(
        (entry) => entry.connectorId === detailKey.connectorId && entry.slug === detailKey.slug,
      ) ?? null
    );
  }, [catalog, detailKey]);

  const pluginServers = (install: CapabilityInstall | undefined) =>
    install ? mcpServers.filter((server) => server.installId === install.id) : [];
  const standaloneServers = mcpServers.filter((server) => !server.installId);
  const connectedItems = catalog.filter((item) => itemConnected(item));
  // Skills live in their own dialog, so only installs with a connector count as apps here.
  const connectorInstalls = pluginInstalls.filter((install) =>
    installedPluginParts(install.config).includes("connector"),
  );
  const appCount =
    connectedItems.length + standaloneServers.length + sources.length + connectorInstalls.length;
  // An added plugin whose managed app is already counted stays one app, not a second mark.
  const addedInstalls = pluginInstalls.filter((install) => {
    const entry = catalogEntries.find((row) => row.installedSource === install.source);
    return !(entry && managedAppFor(entry, connectedItems));
  });
  const addedCount =
    connectedItems.length + addedInstalls.length + standaloneServers.length + sources.length;
  const addedMarks = [
    ...connectedItems.map((item) => {
      const entry = catalogEntries.find((row) => managedAppFor(row, [item]));
      return {
        key: catalogItemKey(item),
        name: item.name,
        logo: item.logo || entry?.logo,
        site: entry ? pluginSite(entry) : null,
      };
    }),
    ...addedInstalls.map((install) => {
      const entry = catalogEntries.find((row) => row.installedSource === install.source);
      return {
        key: install.id,
        name: entry?.displayName ?? install.name,
        logo: entry?.logo,
        site: entry ? pluginSite(entry) : null,
      };
    }),
  ].slice(0, 4);

  const browsing = !plugin && !detailItem && view === "browse";

  function openPlugin(selection: PluginSelection, connect = false) {
    setCatalogError(null);
    setPluginAutoConnect(connect);
    setPlugin(selection);
  }

  /** A managed app whose brand also has a plugin opens one page with its skills. */
  function openApp(item: ConnectionCatalogItem) {
    const entry = pluginForApp.get(catalogItemKey(item));
    if (entry) openPlugin(pluginSelection(entry));
    else openDetail(item);
  }

  const appForPlugin = (selection: PluginSelection) => {
    const entry = catalogEntries.find((row) => row.installedSource === selection.installedSource);
    return entry ? managedAppFor(entry, catalog) : undefined;
  };

  function installedSelection(install: CapabilityInstall): PluginSelection {
    const entry = catalogEntries.find((row) => row.installedSource === install.source);
    return entry
      ? pluginSelection(entry)
      : { source: install.source, installedSource: install.source, name: install.name };
  }

  function managedLink(selection: PluginSelection): ManagedAppLink | undefined {
    const item = appForPlugin(selection);
    if (!item) return undefined;
    return {
      name: item.name,
      logo: item.logo,
      connected: itemConnected(item),
      connecting: pending === catalogItemKey(item),
      onConnect: () => void connect(item),
      onManage: () => {
        setPlugin(null);
        openDetail(item);
      },
    };
  }

  function openDetail(item: ConnectionCatalogItem) {
    setCatalogError(null);
    setDetailKey({ connectorId: item.connectorId, slug: item.slug });
  }

  function closeDetail() {
    setDetailKey(null);
  }

  const tileContext: TileContext = {
    connections: state,
    pluginForApp,
    onOpenApp: openApp,
    onOpenDetail: openDetail,
    onOpenChatApp: onOpenMessaging,
  };

  function beginSource(kind: SourceKind, preset: McpSourcePreset | null = null) {
    setPlugin(null);
    setDetailKey(null);
    setSourceBack("browse");
    setView("source");
    sourceForm.start(kind, preset);
    setSourceError(null);
    setOauthError(null);
    sourceAction.current += 1;
    if (pending === "install-source") setPending(null);
  }

  function beginCatalogSurface(
    result: IntegrationCatalogResult,
    surface: IntegrationCatalogSurface,
  ) {
    if (!surface.source || (surface.kind !== "mcp" && surface.kind !== "openapi")) return;
    setSourceBack("domain");
    setView("source");
    sourceForm.startFromCatalog(result, surface, surface.source);
    setSourceError(null);
    setOauthError(null);
    sourceAction.current += 1;
    if (pending === "install-source") setPending(null);
  }

  async function installSource() {
    const { sourceKind, sourcePreset, sourceName, sourceUrl, credential, authType, authName } =
      sourceForm;
    if (!sourceKind) return;
    const name =
      sourceName.trim() ||
      (sourcePreset?.name ?? (sourceKind === "graphql" ? "GraphQL" : "Custom connector"));
    setSourceError(null);
    setOauthError(null);
    sourceAction.current += 1;
    setPending("install-source");
    const action = sourceAction.current;
    let savedForOauth = false;
    try {
      // OAuth is the MCP server itself signing in, so it is saved first and then authorized.
      if (sourceKind === "mcp" && authType === "oauth") {
        const server = await rpc.mcp.servers.create(customMcpServerInput(name, sourceUrl));
        savedForOauth = true;
        if (action !== sourceAction.current) {
          await refresh().catch(() => undefined);
          return;
        }
        setPending(null);
        sourceForm.setCredential("");
        sourceForm.setSourceKind(null);
        setView("manage");
        await refresh().catch(() => undefined);
        if (action !== sourceAction.current) return;
        const result = await connectMcpOauth(server.id);
        await refresh().catch(() => undefined);
        if (action !== sourceAction.current) return;
        if (result === "cancelled")
          setOauthError(t`Sign-in cancelled. Retry in Manage MCP servers.`);
        return;
      }
      const auth =
        authType === "header"
          ? { type: "header" as const, name: authName.trim() }
          : { type: authType === "bearer" ? ("bearer" as const) : ("none" as const) };
      await rpc.capabilities.install({
        kind: sourceKind,
        name,
        source: sourceUrl.trim(),
        credential: credential.trim() || undefined,
        config: sourcePreset
          ? { preset: sourcePreset.id }
          : sourceKind === "api"
            ? { openApi: true, auth }
            : sourceKind === "graphql"
              ? { auth }
              : { preset: "custom", auth },
      });
      sourceForm.setCredential("");
      sourceForm.setSourceKind(null);
      setView("manage");
      await refresh();
    } catch (err) {
      if (savedForOauth) {
        await refresh().catch(() => undefined);
        if (action !== sourceAction.current) return;
        setOauthError(
          errorCode(err) === MCP_OAUTH_CLIENT_REQUIRED
            ? t`This server needs an OAuth client ID. Add one in Manage MCP servers.`
            : errorText(err, t`Could not complete OAuth`),
        );
        return;
      }
      if (action === sourceAction.current)
        setSourceError(errorText(err, t`Could not install connector`));
    } finally {
      if (!savedForOauth && action === sourceAction.current) setPending(null);
    }
  }

  async function removeSource(install: CapabilityInstall) {
    if (reachesOtherSpaces(install.availability, spaceCount) && confirmingSource !== install.id) {
      setConfirmingSource(install.id);
      return;
    }
    setConfirmingSource(null);
    setPending(install.id);
    setSourceError(null);
    setOauthError(null);
    sourceAction.current += 1;
    try {
      await rpc.capabilities.remove({ id: install.id });
      await updateIntegrations((current) => ({
        ...current,
        sources: current.sources.filter((source) => source.id !== install.id),
      }));
    } catch (err) {
      setSourceError(errorText(err, t`Could not remove connector`));
    } finally {
      setPending(null);
    }
  }

  function openAddView(next: OverlayView) {
    setPlugin(null);
    setDetailKey(null);
    setSourceError(null);
    setOauthError(null);
    sourceAction.current += 1;
    if (pending === "install-source") setPending(null);
    setView(next);
  }

  function leaveSource() {
    sourceForm.close();
    setSourceError(null);
    setOauthError(null);
    sourceAction.current += 1;
    if (pending === "install-source") setPending(null);
    setView(sourceBack);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} size="2xl" className="bg-card">
        <DialogHeader
          className={`flex-row justify-between px-8 pt-4 ${plugin ? "items-center" : "items-end"}`}
        >
          {view === "manage" && !plugin && !detailItem ? (
            <div className="pb-1">
              <Button
                type="button"
                variant="ghost"
                className="-ms-2 gap-1 px-2 text-body font-medium text-foreground"
                aria-label={t`Back`}
                onClick={() => setView("browse")}
              >
                <ChevronLeft />
                <Trans>Connect Apps</Trans>
              </Button>
              <DialogTitle className="sr-only">
                <Trans>Connect Apps</Trans>
              </DialogTitle>
            </div>
          ) : plugin ? (
            <div className="flex min-w-0 items-center">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t`Back`}
                onClick={() => {
                  setPluginAutoConnect(false);
                  setPlugin(null);
                }}
              >
                <ChevronLeft />
              </Button>
              <DialogTitle className="sr-only">
                <Trans>Connect Apps</Trans>
              </DialogTitle>
            </div>
          ) : (
            <DialogTitle className="pb-1.5 text-heading2 text-foreground">
              <Trans>Connect Apps</Trans>
            </DialogTitle>
          )}
          <div className="flex flex-col items-end gap-1">
            <DialogClose
              render={<Button variant="ghost" size="icon-sm" aria-label={t`Close integrations`} />}
            >
              <X />
            </DialogClose>
            {browsing ? (
              <div className="flex items-center gap-1">
                {browsing && addedCount > 0 ? (
                  <Button
                    variant="ghost"
                    size="lg"
                    className="gap-2.5 px-2.5 text-body text-muted-foreground"
                    onClick={() => setView("manage")}
                  >
                    <span aria-hidden className="flex -space-x-2">
                      {addedMarks.map((mark) => (
                        <span key={mark.key} className="rounded-md ring-2 ring-card">
                          <AddedMark name={mark.name} logo={mark.logo} site={mark.site} />
                        </span>
                      ))}
                    </span>
                    <Plural value={addedCount} one="# connected" other="# connected" />
                    <ChevronRight />
                  </Button>
                ) : null}
                <AddMenu
                  presets={sourcePresets}
                  onGithub={() => openAddView("github")}
                  onSource={beginSource}
                  onBrowseMcp={() => {
                    setPublicCatalogQuery("");
                    openAddView("browseMcp");
                  }}
                  onDomainSearch={catalogFeedEnabled ? () => openAddView("domain") : undefined}
                  onOpenMcp={onOpenMcp}
                />
              </div>
            ) : null}
          </div>
        </DialogHeader>

        {browsing ? (
          <div className="space-y-4 px-8 pt-4">
            <div className="flex items-center gap-3">
              <Input
                disabled={loading}
                className="min-w-0 flex-1 rounded-xl bg-foreground/5 dark:bg-foreground/10"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setVisibleCount(CONNECTION_CATALOG_PAGE_SIZE);
                }}
                aria-label={t`Search apps`}
                placeholder={t`Search across apps and skills`}
                size="lg"
              />
              {onOpenTemplates ? (
                <Button
                  variant="outline"
                  size="lg"
                  className="shrink-0 rounded-full px-3.5"
                  data-testid="open-bot-templates"
                  onClick={onOpenTemplates}
                >
                  <LogoAvatar
                    size={16}
                    motion={false}
                    className="size-4"
                    avatarValue="#FFFFFF"
                    identity="bot-templates"
                  />
                  <Trans>Bot templates</Trans>
                  <ChevronRight />
                </Button>
              ) : null}
            </div>
            {categories.length >= 2 || category ? (
              <div className="flex flex-wrap gap-2" data-testid="integration-categories">
                {[null, ...categories.slice(0, CHIP_COUNT)].map((name) => (
                  <Button
                    key={name ?? "all"}
                    type="button"
                    variant={category === name ? "default" : "secondary"}
                    aria-pressed={category === name}
                    className="rounded-full px-3.5 text-body-sm"
                    onClick={() => {
                      setCategory(name);
                      setPluginCount(PLUGIN_PAGE_SIZE);
                    }}
                  >
                    {name ? categoryLabel(name) : <Trans>All</Trans>}
                  </Button>
                ))}
                {categories.length > CHIP_COUNT ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          type="button"
                          variant={
                            category && !categories.slice(0, CHIP_COUNT).includes(category)
                              ? "default"
                              : "secondary"
                          }
                          className="rounded-full px-3.5 text-body-sm"
                        />
                      }
                    >
                      {category && !categories.slice(0, CHIP_COUNT).includes(category) ? (
                        categoryLabel(category)
                      ) : (
                        <Trans>More</Trans>
                      )}
                      <ChevronDown />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-auto">
                      {categories.slice(CHIP_COUNT).map((name) => (
                        <DropdownMenuItem
                          key={name}
                          onClick={() => {
                            setCategory(name);
                            setPluginCount(PLUGIN_PAGE_SIZE);
                          }}
                        >
                          {categoryLabel(name)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>
            ) : null}
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
          {catalogError || loadError ? (
            <div className="mb-4 flex items-center gap-3">
              <p className="text-body text-destructive">{catalogError ?? loadError}</p>
              {!catalogLoaded || (loadError && !catalogError) ? (
                <Button variant="outline" size="sm" onClick={() => void integrations.refetch()}>
                  <Trans>Retry</Trans>
                </Button>
              ) : null}
            </div>
          ) : null}

          {plugin ? (
            <PluginDetail
              key={plugin.installedSource}
              selection={plugin}
              installs={pluginInstalls}
              servers={mcpServers}
              assigned={assigned}
              activeBotId={activeBotId}
              managed={managedLink(plugin)}
              autoConnect={pluginAutoConnect}
              onBack={() => {
                setPluginAutoConnect(false);
                setPlugin(null);
              }}
              onChanged={refresh}
            />
          ) : detailItem ? (
            <ConnectorDetail
              item={detailItem}
              state={state}
              onBack={closeDetail}
              onOpenChatApp={onOpenMessaging}
            />
          ) : view === "manage" ? (
            <ManageView
              state={state}
              connectedItems={connectedItems}
              connectorInstalls={connectorInstalls}
              standaloneServers={standaloneServers}
              appCount={appCount}
              sourceError={sourceError ?? oauthError}
              confirmingSource={confirmingSource}
              onRemoveSource={(install) => void removeSource(install)}
              onOpenMcp={onOpenMcp}
              installedSelection={installedSelection}
              pluginServers={pluginServers}
              onOpenPlugin={openPlugin}
              onOpenApp={openApp}
            />
          ) : view === "github" ? (
            <GithubImport
              value={gitSource}
              onChange={setGitSource}
              onBack={() => setView("browse")}
              onPreview={openPlugin}
            />
          ) : view === "source" ? (
            <SourceFormView
              form={sourceForm}
              installing={pending === "install-source"}
              sourceError={sourceError}
              onBack={leaveSource}
              onSubmit={() => void installSource()}
            />
          ) : view === "domain" ? (
            <DomainSearch
              state={domainSearch}
              onBack={() => setView("browse")}
              onPick={beginCatalogSurface}
            />
          ) : view === "browseMcp" ? (
            <div className="space-y-6">
              <ViewTitle
                title={<Trans>Browse MCP servers</Trans>}
                onBack={() => setView("browse")}
              />
              <IntegrationSetup
                botId={activeBotId}
                initialQuery={publicCatalogQuery || undefined}
                onDone={() => {
                  setView("manage");
                  void refresh().catch((err: unknown) =>
                    setCatalogError(errorText(err, t`Could not load integrations`)),
                  );
                }}
              />
            </div>
          ) : (
            <PluginBrowse
              browse={browse}
              state={state}
              tileContext={tileContext}
              onOpenPlugin={openPlugin}
              onConnectPlugin={(selection) => openPlugin(selection, true)}
              onSearchPublic={(publicQuery) => {
                setPublicCatalogQuery(publicQuery);
                openAddView("browseMcp");
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
