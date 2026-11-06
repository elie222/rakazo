import type {
  CapabilityInstall,
  Connection,
  ConnectionCatalogItem,
  McpServer,
  McpServerConnection,
  McpSourcePreset,
  PluginMarketplaceEntry,
} from "@rakazo/contracts";
import { mcpServerConnection, mcpServerNeedsSignIn, SUBMIT_PLUGIN_URL } from "@rakazo/contracts";
import type { PluginCategory } from "@rakazo/core";
import {
  buildFeaturedConnectorTiles,
  CONNECTION_CATALOG_PAGE_SIZE,
  catalogItemAccounts,
  catalogItemKey,
  connectCatalogItem,
  EMPTY_PLUGIN_CATALOG_MESSAGE,
  filterConnectionCatalogItems,
  integrationCatalogsReady,
  isCatalogItemConnected,
  matchesWordPrefixes,
  newClientId,
  OTHER_PLUGINS,
} from "@rakazo/core";
import type { NativeStackNavigationOptions } from "expo-router";
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AppState,
  Linking,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type {
  AddCustomOption,
  SourceAuth,
  SourceKind,
} from "../../components/add-custom-integration";
import { AddCustomForm, AddCustomMenu } from "../../components/add-custom-integration";
import { BotTemplateIcon } from "../../components/bot-template-icon";
import { ConnectorIcon } from "../../components/connector-icon";
import type { ConnectionTool } from "../../components/integration-detail";
import { IntegrationDetail } from "../../components/integration-detail";
import { PLUGIN_PAGE_SIZE, PluginSection } from "../../components/integration-plugins";
import { createIntegrationsStyles, LOGO_SIZE } from "../../components/integrations-styles";
import { MenuPicker } from "../../components/menu-picker";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSymbol } from "../../components/native-symbol";
import { PluginIcon } from "../../components/plugin-icon";
import { Chevron } from "../../components/row-accessories";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import type { IntegrationsCacheScope, IntegrationsSnapshot } from "../../lib/integrations-cache";
import {
  integrationsCacheScope,
  isIntegrationsScopeCurrent,
  persistedIntegrationsCacheScope,
  readIntegrationsCache,
  writeIntegrationsCache,
} from "../../lib/integrations-cache";
import { loadLastBotId } from "../../lib/last-bot";
import { native, useThemedStyles } from "../../lib/native";
import { iosAtLeast } from "../../lib/native-controls";
import type { PluginParams } from "../../lib/plugin-marketplace";
import {
  browsablePlugins,
  filterPlugins,
  gitImportParams,
  hasPluginConnector,
  managedPluginParams,
  pluginCategories,
  pluginParams,
} from "../../lib/plugin-marketplace";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

export default function Integrations() {
  const sideInsets = useSideInsets();
  const router = useRouter();
  // A merged brand's plugin page sends people back here to manage the app's accounts.
  const { app: appToOpen } = useLocalSearchParams<{ app?: string }>();
  const navigation = useNavigation();
  const styles = useThemedStyles(createIntegrationsStyles);
  const { t } = useI18n();
  const categoryLabels: Record<PluginCategory, string> = {
    productivity: t("Productivity"),
    communication: t("Communication"),
    sales: t("Sales & CRM"),
    marketing: t("Marketing"),
    finance: t("Finance"),
    people: t("Recruiting & HR"),
    design: t("Design"),
    code: t("Developer"),
    data: t("Data"),
    ops: t("Security & Ops"),
  };
  const categoryLabel = (name: string) => categoryLabels[name as PluginCategory] ?? name;
  const { width } = useWindowDimensions();
  const catalogColumns = width >= 480 ? 2 : 1;
  const [catalog, setCatalog] = useState<ConnectionCatalogItem[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(CONNECTION_CATALOG_PAGE_SIZE);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [sources, setSources] = useState<CapabilityInstall[]>([]);
  const [pluginInstalls, setPluginInstalls] = useState<CapabilityInstall[]>([]);
  const [pluginEntries, setPluginEntries] = useState<PluginMarketplaceEntry[]>([]);
  const [pluginsState, setPluginsState] = useState<"loading" | "ready" | "partial">("loading");
  const [category, setCategory] = useState("");
  const [pluginCount, setPluginCount] = useState(PLUGIN_PAGE_SIZE);
  const [gitUrl, setGitUrl] = useState("");
  const [sourceKind, setSourceKind] = useState<SourceKind | null>(null);
  const [sourcePresets, setSourcePresets] = useState<McpSourcePreset[]>([]);
  const [sourcePreset, setSourcePreset] = useState<McpSourcePreset | null>(null);
  const [adding, setAdding] = useState<"github" | "source" | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [sourceAuth, setSourceAuth] = useState<SourceAuth>("none");
  const [authHeader, setAuthHeader] = useState("x-api-key");
  const [oauthServerId, setOauthServerId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [lastBotId, setLastBotId] = useState("");
  const [catalogReady, setCatalogReady] = useState(false);
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [detailKey, setDetailKey] = useState<{ connectorId: string; slug: string } | null>(null);
  const [tools, setTools] = useState<ConnectionTool[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(true);
  const [toolsTick, setToolsTick] = useState(0);
  const connectionAttempt = useRef<AbortController | null>(null);
  const oauthBrowserOpen = useRef(false);

  const cacheScope = useRef<IntegrationsCacheScope | null>(null);
  const snapshot = useRef<IntegrationsSnapshot>({ catalog: [], connections: [] });
  const mounted = useRef(false);
  const focusGeneration = useRef(0);
  const refreshGeneration = useRef(0);
  const sourcesGeneration = useRef(0);

  function applySnapshot(next: IntegrationsSnapshot) {
    snapshot.current = next;
    setCatalog(next.catalog);
    setConnections(next.connections);
    setCatalogReady(true);
    setLabelDrafts((current) =>
      Object.fromEntries(
        next.connections
          .filter((row) => row.status === "connected" || row.status === "pending")
          .map((row) => [row.id, current[row.id] ?? row.displayName]),
      ),
    );
  }

  function saveSnapshot(next: IntegrationsSnapshot) {
    const scope = cacheScope.current;
    if (!mounted.current || !scope || !isIntegrationsScopeCurrent(scope)) return;
    // A mutation invalidates any earlier background refresh.
    refreshGeneration.current += 1;
    applySnapshot(next);
    writeIntegrationsCache(scope, next);
  }

  function captureConnectionScope() {
    const scope = cacheScope.current;
    const focus = focusGeneration.current;
    return () => {
      const current = cacheScope.current;
      return (
        !!scope &&
        !!current &&
        mounted.current &&
        focus === focusGeneration.current &&
        isIntegrationsScopeCurrent(scope) &&
        scope.userId === current.userId &&
        scope.spaceId === current.spaceId
      );
    };
  }

  function updateAccount(row: Connection) {
    const connections = [
      ...snapshot.current.connections.filter((entry) => entry.id !== row.id),
      row,
    ];
    saveSnapshot({
      connections,
      catalog: snapshot.current.catalog.map((item) =>
        item.connectorId === row.connectorId && item.slug === row.provider
          ? {
              ...item,
              connected: connections.some(
                (entry) =>
                  entry.connectorId === item.connectorId &&
                  entry.provider === item.slug &&
                  entry.status === "connected",
              ),
            }
          : item,
      ),
    });
  }

  const catalogsReady = integrationCatalogsReady({
    catalogLoaded: catalogReady,
    catalogFailed: !!catalogError,
    pluginsLoaded: pluginsState !== "loading",
    pluginsUnavailable: pluginsState === "partial",
  });
  const featuredTiles = useMemo(() => buildFeaturedConnectorTiles(catalog), [catalog]);
  const showFeatured = !query.trim();
  const catalogApps = useMemo(() => filterConnectionCatalogItems(catalog, query), [catalog, query]);
  const renderedApps = catalogApps.slice(0, visibleCount);
  const { plugins, pluginForApp } = useMemo(
    () => browsablePlugins(pluginEntries, catalog),
    [pluginEntries, catalog],
  );
  // Managed apps standing in for a plugin keep that plugin's category, so a category lists them too.
  const mergedBrands = catalog.flatMap((item) => {
    const entry = pluginForApp.get(catalogItemKey(item));
    return entry ? [{ item, entry }] : [];
  });
  const categories = pluginCategories([...plugins, ...mergedBrands.map(({ entry }) => entry)]);
  const brandMatches = category
    ? mergedBrands.filter(
        ({ item, entry }) =>
          entry.category === (category === OTHER_PLUGINS ? null : category) &&
          (matchesWordPrefixes(item.name, query) ||
            filterPlugins([entry], query, null, categoryLabel).length > 0),
      )
    : [];
  const pluginMatches = filterPlugins(plugins, query, category || null, categoryLabel);
  const filtering = Boolean(query.trim() || category);
  const installedSources = new Set(pluginInstalls.map((install) => install.source));
  const standaloneServers = mcpServers.filter((server) => !server.installId);
  const savedServerMatches =
    query.trim() && !category
      ? standaloneServers.filter((server) =>
          matchesWordPrefixes(`${server.name} ${server.description}`, query),
        )
      : [];
  const connectorPlugins = pluginInstalls.filter(hasPluginConnector);

  const detailItem = useMemo(() => {
    if (!detailKey) return null;
    return (
      catalog.find(
        (entry) => entry.connectorId === detailKey.connectorId && entry.slug === detailKey.slug,
      ) ?? null
    );
  }, [catalog, detailKey]);

  function clearStaleScope() {
    if (!cacheScope.current || isIntegrationsScopeCurrent(cacheScope.current)) return;
    cacheScope.current = null;
    refreshGeneration.current += 1;
    sourcesGeneration.current += 1;
    applySnapshot({ catalog: [], connections: [] });
    setCatalogReady(false);
    setSources([]);
    setPluginInstalls([]);
    setPluginEntries([]);
    setPluginsState("loading");
    setMcpServers([]);
    setMcpError(null);
    setDetailKey(null);
    setLabelDrafts({});
    setPending(null);
    connectionAttempt.current?.abort();
  }

  async function refresh() {
    const focus = focusGeneration.current;
    clearStaleScope();
    let scope: IntegrationsCacheScope;
    try {
      scope = await integrationsCacheScope();
    } catch (reason) {
      if (!mounted.current || focus !== focusGeneration.current) return;
      if (cacheScope.current && !isIntegrationsScopeCurrent(cacheScope.current)) {
        clearStaleScope();
        return refresh();
      }
      throw reason;
    }
    if (!mounted.current || focus !== focusGeneration.current) return;
    if (!isIntegrationsScopeCurrent(scope)) {
      clearStaleScope();
      return refresh();
    }
    setPluginsState("loading");
    const previous = cacheScope.current;
    if (previous && (previous.userId !== scope.userId || previous.spaceId !== scope.spaceId)) {
      applySnapshot({ catalog: [], connections: [] });
      setCatalogReady(false);
      setSources([]);
      setPluginInstalls([]);
      setPluginEntries([]);
      setMcpServers([]);
      setMcpError(null);
      setDetailKey(null);
      setLabelDrafts({});
      setSourcePresets([]);
    }
    cacheScope.current = scope;
    if (!previous || previous.userId !== scope.userId || previous.spaceId !== scope.spaceId) {
      const cached = readIntegrationsCache(scope);
      if (cached) applySnapshot(cached);
    }
    const generation = ++refreshGeneration.current;
    const sourceGeneration = ++sourcesGeneration.current;
    void rpc("mcp/servers/list")
      .then((servers) => {
        if (
          mounted.current &&
          focus === focusGeneration.current &&
          isIntegrationsScopeCurrent(scope) &&
          sourceGeneration === sourcesGeneration.current
        ) {
          setMcpServers(servers);
          setMcpError(null);
        }
      })
      .catch((reason) => {
        if (
          mounted.current &&
          focus === focusGeneration.current &&
          isIntegrationsScopeCurrent(scope) &&
          sourceGeneration === sourcesGeneration.current
        )
          setMcpError(errorText(reason, t("Could not load MCP servers")));
      });
    void rpc("capabilities/list")
      .then((installs) => {
        if (
          mounted.current &&
          isIntegrationsScopeCurrent(scope) &&
          sourceGeneration === sourcesGeneration.current
        ) {
          setSources(
            installs.filter(
              (item) => item.kind === "mcp" || item.kind === "api" || item.kind === "graphql",
            ),
          );
          setPluginInstalls(installs.filter((item) => item.kind === "plugin"));
        }
      })
      .catch(() => undefined);
    // A server without presets (or a failed request) offers none, never another server's.
    const applyPresets = (presets: McpSourcePreset[]) => {
      if (
        mounted.current &&
        isIntegrationsScopeCurrent(scope) &&
        sourceGeneration === sourcesGeneration.current
      )
        setSourcePresets(presets);
    };
    void rpc("capabilities/sourcePresets")
      .then(applyPresets)
      .catch(() => applyPresets([]));
    void rpc("marketplace/catalog", { query: "" })
      .then((result) => {
        if (
          mounted.current &&
          isIntegrationsScopeCurrent(scope) &&
          sourceGeneration === sourcesGeneration.current
        ) {
          setPluginEntries(result.entries);
          setPluginsState(result.unavailableRegistries.length ? "partial" : "ready");
        }
      })
      .catch(() => {
        if (mounted.current && sourceGeneration === sourcesGeneration.current)
          setPluginsState("partial");
      });
    setCatalogError(null);
    let next: IntegrationsSnapshot;
    try {
      // The catalog call reconciles connection rows, so list them after it.
      const catalog = await rpc("connections/catalog");
      const connections = await rpc("connections/list");
      next = { catalog, connections };
    } catch (reason) {
      if (!mounted.current || focus !== focusGeneration.current) return;
      if (!isIntegrationsScopeCurrent(scope)) return refresh();
      if (generation === refreshGeneration.current) throw reason;
      return;
    }
    if (!mounted.current || focus !== focusGeneration.current) return;
    if (!isIntegrationsScopeCurrent(scope)) return refresh();
    if (generation !== refreshGeneration.current) return;
    applySnapshot(next);
    writeIntegrationsCache(scope, next);
  }

  async function retryRefresh() {
    const focus = focusGeneration.current;
    try {
      await refresh();
    } catch (reason) {
      if (
        mounted.current &&
        focus === focusGeneration.current &&
        (!cacheScope.current || isIntegrationsScopeCurrent(cacheScope.current))
      ) {
        setCatalogError(errorText(reason, t("Could not load integrations")));
      }
    }
  }

  useFocusEffect(
    useCallback(() => {
      mounted.current = true;
      focusGeneration.current += 1;
      let cancelled = false;
      clearStaleScope();
      void (async () => {
        const scope = await persistedIntegrationsCacheScope();
        if (cancelled) return;
        if (scope && isIntegrationsScopeCurrent(scope)) {
          cacheScope.current = scope;
          const cached = readIntegrationsCache(scope);
          if (cached) applySnapshot(cached);
        }
        await retryRefresh();
      })();
      void loadLastBotId().then((id) => {
        if (!cancelled) setLastBotId(id);
      });
      return () => {
        cancelled = true;
        mounted.current = false;
        focusGeneration.current += 1;
        refreshGeneration.current += 1;
        sourcesGeneration.current += 1;
        connectionAttempt.current?.abort();
        setPending(null);
      };
    }, []),
  );

  useEffect(() => {
    // The OAuth callback lands in the browser, so refresh once the user comes back.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" || !oauthBrowserOpen.current || !mounted.current) return;
      oauthBrowserOpen.current = false;
      void retryRefresh();
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!detailKey) {
      setTools([]);
      setToolsLoading(false);
      return;
    }
    let cancelled = false;
    setToolsLoading(true);
    void rpc("connections/tools", {
      connectorId: detailKey.connectorId,
      provider: detailKey.slug,
    })
      .then((list) => {
        if (!cancelled) setTools(list);
      })
      .catch(() => {
        if (!cancelled) setTools([]);
      })
      .finally(() => {
        if (!cancelled) setToolsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [detailKey, toolsTick]);

  useEffect(() => {
    if (!appToOpen || !catalogReady) return;
    const item = catalog.find((entry) => catalogItemKey(entry) === appToOpen);
    if (item) openDetail(item);
    router.setParams({ app: undefined });
  }, [appToOpen, catalogReady, catalog]);

  function openPlugin(params: PluginParams) {
    router.push({ pathname: "/plugin", params });
  }

  function installedParams(install: CapabilityInstall): PluginParams {
    const entry = pluginEntries.find((row) => row.installedSource === install.source);
    return entry
      ? pluginParams(entry)
      : { source: install.source, installedSource: install.source, name: install.name };
  }

  function serverStatus(state: McpServerConnection): string {
    switch (state) {
      case "disabled":
        return t("Disabled");
      case "needs_client":
        return t("Needs an OAuth client ID");
      case "needs_sign_in":
        return t("Needs sign-in");
      case "not_working":
        return t("Not working");
      case "connected":
        return t("Connected");
      case "not_connected":
        return t("Not connected");
    }
  }

  function renderInstalledPlugin(install: CapabilityInstall, summary: string, signIn: boolean) {
    const params = installedParams(install);
    return (
      <Pressable
        key={install.id}
        testID="installed-plugin"
        accessibilityRole="button"
        accessibilityLabel={params.name}
        onPress={() => openPlugin(params)}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        <PluginIcon logo={params.logo} name={params.name} site={params.site} size={LOGO_SIZE} />
        <View style={styles.grow}>
          <Text numberOfLines={1} style={styles.title}>
            {params.name}
          </Text>
          <Text numberOfLines={1} style={styles.secondary}>
            {summary}
          </Text>
        </View>
        {signIn ? (
          <NativeActionButton
            fill={false}
            label={t("Sign in")}
            onPress={() => openPlugin(params)}
            prominence="secondary"
          />
        ) : null}
      </Pressable>
    );
  }

  /** What this account already has: apps it can reach, then skills it follows. */
  function renderSavedServer(server: McpServer) {
    const state = mcpServerConnection(server);
    const tokens = mobileTokens();
    const warning = state === "needs_sign_in" || state === "needs_client";
    const color =
      state === "connected"
        ? tokens.success
        : warning
          ? tokens.warning
          : state === "not_working"
            ? tokens.destructive
            : native.secondaryLabel;
    const symbol =
      state === "connected"
        ? { ios: "checkmark", android: "checkmark" as const }
        : warning
          ? { ios: "exclamationmark.triangle", android: "warning-outline" as const }
          : state === "not_working"
            ? { ios: "exclamationmark.circle", android: "alert-circle-outline" as const }
            : null;
    return (
      <View key={server.id} testID="registered-mcp-server" style={styles.row}>
        <ConnectorIcon name={server.name} size={LOGO_SIZE} />
        <Text numberOfLines={1} style={[styles.title, styles.grow]}>
          {server.name}
        </Text>
        <View style={styles.connectionStatus}>
          {symbol ? (
            <View
              accessible={false}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <NativeSymbol {...symbol} size={14} color={color} />
            </View>
          ) : null}
          <Text style={[styles.secondary, { color }]}>{serverStatus(state)}</Text>
        </View>
        {server.enabled &&
        state !== "connected" &&
        state !== "needs_client" &&
        (server.oauthStatus === "reconnect" || server.id === oauthServerId) ? (
          <NativeActionButton
            label={server.oauthStatus === "reconnect" ? t("Reconnect") : t("Connect")}
            fill={false}
            busy={pending === `oauth:${server.id}`}
            onPress={() => void authorizeMcp(server.id)}
            prominence="secondary"
          />
        ) : null}
      </View>
    );
  }

  function renderConnected() {
    const apps = connectorPlugins.length + standaloneServers.length + sources.length;
    return (
      <>
        {apps || mcpError ? (
          <View testID="connected-apps" style={styles.catalogStack}>
            <Text style={styles.section}>{t("Apps")}</Text>
            {mcpError ? (
              <View>
                <Text style={styles.error}>{mcpError}</Text>
                <NativeActionButton
                  label={t("Retry")}
                  fill={false}
                  onPress={() => void retryRefresh()}
                  prominence="secondary"
                />
              </View>
            ) : null}
            {connectorPlugins.map((install) => {
              const servers = mcpServers.filter((server) => server.installId === install.id);
              return renderInstalledPlugin(
                install,
                servers.length === 1
                  ? t("1 connector")
                  : t("{count} connectors", { count: servers.length }),
                servers.some(mcpServerNeedsSignIn),
              );
            })}
            {standaloneServers.map(renderSavedServer)}
            {sources.map((source) => (
              <View key={source.id} testID="tool-source" style={styles.row}>
                <ConnectorIcon name={source.name} size={LOGO_SIZE} />
                <View style={styles.grow}>
                  <Text numberOfLines={1} style={styles.title}>
                    {source.name}
                  </Text>
                  <Text numberOfLines={1} style={styles.secondary}>
                    {source.kind === "api"
                      ? "OpenAPI"
                      : source.kind === "graphql"
                        ? "GraphQL"
                        : "MCP"}
                  </Text>
                </View>
                <NativeActionButton
                  fill={false}
                  label={pending === source.id ? t("Removing…") : t("Remove")}
                  onPress={() => void removeSource(source)}
                  prominence="destructive"
                />
              </View>
            ))}
          </View>
        ) : null}
      </>
    );
  }

  function closeAdding() {
    setAdding(null);
    setSourceKind(null);
    setSourceError(null);
    setName("");
    setUrl("");
    setCredential("");
  }

  function openDetail(item: ConnectionCatalogItem) {
    setCatalogError(null);
    setToolsOpen(true);
    setDetailKey({ connectorId: item.connectorId, slug: item.slug });
  }

  function closeDetail() {
    setDetailKey(null);
    setTools([]);
  }

  function accountsFor(item: Pick<ConnectionCatalogItem, "connectorId" | "slug">) {
    return catalogItemAccounts(connections, item);
  }

  function itemConnected(item: ConnectionCatalogItem) {
    return isCatalogItemConnected(connections, item);
  }

  async function notifyAppConnected(item: ConnectionCatalogItem, isCurrent: () => boolean) {
    const botId = lastBotId || (await loadLastBotId());
    if (!botId || !isCurrent()) return;
    if (botId !== lastBotId) setLastBotId(botId);
    void rpc("onboarding/appConnected", {
      botId,
      provider: item.slug,
      connectorId: item.connectorId,
    }).catch(() => undefined);
  }

  async function connect(item: ConnectionCatalogItem) {
    const isCurrent = captureConnectionScope();
    if (!isCurrent()) return;
    connectionAttempt.current?.abort();
    const controller = new AbortController();
    connectionAttempt.current = controller;
    const key = catalogItemKey(item);
    setPending(key);
    setCatalogError(null);
    try {
      const result = await connectCatalogItem(item, connections, {
        begin: (input) => rpc("connections/begin", input),
        complete: (input) => rpc("connections/complete", input),
        openUrl: (url) => Linking.openURL(url),
        signal: controller.signal,
        isCurrent,
      });
      if (result.status === "aborted") return;
      if (result.status === "connected") {
        if (result.row) updateAccount(result.row);
        void notifyAppConnected(item, isCurrent);
        await refresh();
        if (isCurrent()) setToolsTick((tick) => tick + 1);
        return;
      }
      Alert.alert(
        t("Connection pending"),
        t("Finish connecting in the browser, then refresh this page."),
      );
    } catch (reason) {
      if (controller.signal.aborted || !isCurrent()) return;
      setCatalogError(errorText(reason, t("Could not connect")));
    } finally {
      if (connectionAttempt.current === controller) {
        connectionAttempt.current = null;
        if (isCurrent()) setPending(null);
      }
    }
  }

  async function revokeAccount(row: Connection) {
    const isCurrent = captureConnectionScope();
    if (!isCurrent()) return;
    setPending(row.id);
    setCatalogError(null);
    try {
      await rpc("connections/revoke", { connectionId: row.id });
      if (!isCurrent()) return;
      updateAccount({ ...row, status: "revoked" });
      await refresh();
      if (isCurrent()) setToolsTick((tick) => tick + 1);
    } catch (reason) {
      if (!isCurrent()) return;
      setCatalogError(errorText(reason, t("Could not revoke connection")));
    } finally {
      if (isCurrent()) setPending(null);
    }
  }

  async function renameAccount(row: Connection) {
    const displayName = (labelDrafts[row.id] ?? row.displayName).trim();
    if (!displayName || displayName === row.displayName) return;
    const isCurrent = captureConnectionScope();
    if (!isCurrent()) return;
    setPending(`rename:${row.id}`);
    setCatalogError(null);
    try {
      const updated = await rpc("connections/rename", {
        connectionId: row.id,
        displayName,
      });
      if (!isCurrent()) return;
      updateAccount(updated);
      setLabelDrafts((current) => ({ ...current, [row.id]: updated.displayName }));
    } catch (reason) {
      if (!isCurrent()) return;
      setCatalogError(errorText(reason, t("Could not rename connection")));
    } finally {
      if (isCurrent()) setPending(null);
    }
  }

  async function uninstall(item: ConnectionCatalogItem) {
    const isCurrent = captureConnectionScope();
    if (!isCurrent()) return;
    const matches = accountsFor(item);
    const key = catalogItemKey(item);
    if (matches.length === 0) {
      closeDetail();
      return;
    }
    setPending(`uninstall:${key}`);
    setCatalogError(null);
    try {
      for (const row of matches) {
        await rpc("connections/revoke", { connectionId: row.id });
        if (!isCurrent()) return;
        updateAccount({ ...row, status: "revoked" });
      }
      await refresh();
      if (isCurrent()) closeDetail();
    } catch (reason) {
      if (!isCurrent()) return;
      setCatalogError(errorText(reason, t("Could not revoke connection")));
      await refresh().catch(() => undefined);
    } finally {
      if (isCurrent()) setPending(null);
    }
  }

  function beginSource(kind: SourceKind, preset: McpSourcePreset | null = null) {
    setAdding("source");
    setSourceKind(kind);
    setSourcePreset(preset);
    setSourceError(null);
    setName(preset?.name ?? "");
    setUrl(preset?.url ?? "");
    setCredential("");
    setSourceAuth(preset ? "bearer" : "none");
    setAuthHeader("x-api-key");
  }

  async function authorizeMcp(serverId: string) {
    const isCurrent = captureConnectionScope();
    if (!isCurrent()) return;
    setPending(`oauth:${serverId}`);
    setMcpError(null);
    try {
      // The API picks the registered web callback; native clients cannot supply one.
      const result = await rpc("mcp/oauth/begin", { serverId });
      if (!isCurrent()) return;
      if (result.status === "authorization_required") {
        oauthBrowserOpen.current = true;
        await Linking.openURL(result.authorizationUrl);
      } else {
        await refresh();
      }
    } catch (reason) {
      if (isCurrent()) setMcpError(errorText(reason, t("Could not start MCP OAuth")));
    } finally {
      if (isCurrent()) setPending(null);
    }
  }

  async function addSource() {
    if (!sourceKind) return;
    const isCurrent = captureConnectionScope();
    if (!isCurrent()) return;
    setPending("source");
    setSourceError(null);
    const displayName =
      name.trim() ||
      (sourcePreset?.name ?? (sourceKind === "graphql" ? "GraphQL" : t("Custom connector")));
    const auth =
      sourceAuth === "header"
        ? { type: "header", name: authHeader.trim() }
        : { type: sourceAuth === "bearer" ? "bearer" : "none" };
    let created: McpServer | null = null;
    try {
      if (sourceAuth === "oauth") {
        created = await rpc("mcp/servers/create", {
          slug: `integration-${newClientId().slice(0, 8)}`,
          name: displayName,
          transport: "streamable_http",
          endpoint: url.trim(),
        });
        if (!isCurrent()) return;
        setOauthServerId(created.id);
      } else {
        await rpc("capabilities/install", {
          kind: sourceKind,
          name: displayName,
          source: url.trim(),
          credential: (sourceAuth !== "none" && credential.trim()) || undefined,
          config: sourcePreset
            ? { preset: sourcePreset.id }
            : sourceKind === "api"
              ? { openApi: true, auth }
              : sourceKind === "graphql"
                ? { auth }
                : { preset: "custom", auth },
        });
        if (!isCurrent()) return;
      }
      setCredential("");
      setSourceKind(null);
      setAdding(null);
      await refresh();
      if (created) await authorizeMcp(created.id);
    } catch (reason) {
      if (isCurrent()) setSourceError(errorText(reason, t("Could not add source")));
    } finally {
      if (isCurrent()) setPending(null);
    }
  }

  async function removeSource(source: CapabilityInstall) {
    setPending(source.id);
    setSourceError(null);
    try {
      await rpc("capabilities/remove", { id: source.id });
      setSources((current) => current.filter((item) => item.id !== source.id));
    } catch (reason) {
      setSourceError(errorText(reason, t("Could not remove source")));
    } finally {
      setPending(null);
    }
  }

  function renderCatalogActions(item: ConnectionCatalogItem, label: string) {
    const key = catalogItemKey(item);
    const connected = itemConnected(item);
    const connecting = pending === key;
    if (connected) {
      return (
        <NativeActionButton
          accessibilityLabel={t("Added")}
          disabled={connecting}
          fill={false}
          label={connecting ? t("Working…") : t("Added")}
          onPress={() => openDetail(item)}
          prominence="secondary"
        />
      );
    }
    return (
      <NativeActionButton
        accessibilityLabel={t("Add {name}", { name: label })}
        disabled={connecting}
        fill={false}
        label={connecting ? t("Working…") : t("Add")}
        onPress={() => void connect(item)}
        prominence="secondary"
      />
    );
  }

  function renderCatalogTile(item: ConnectionCatalogItem, label: string) {
    const connected = itemConnected(item);
    const brandPlugin = pluginForApp.get(catalogItemKey(item));
    const body = (
      <>
        <ConnectorIcon logo={item.logo} name={label} size={LOGO_SIZE} />
        <View style={styles.grow}>
          <Text numberOfLines={1} style={styles.title}>
            {label}
          </Text>
        </View>
        {renderCatalogActions(item, label)}
      </>
    );
    const tileStyle = [styles.row, catalogColumns === 2 ? styles.catalogCell : null];
    if (connected || brandPlugin) {
      return (
        <Pressable
          key={catalogItemKey(item)}
          accessibilityRole="button"
          onPress={() =>
            brandPlugin ? openPlugin(managedPluginParams(brandPlugin, item)) : openDetail(item)
          }
          style={tileStyle}
        >
          {body}
        </Pressable>
      );
    }
    return (
      <View key={catalogItemKey(item)} style={tileStyle}>
        {body}
      </View>
    );
  }

  const addOptions: AddCustomOption[] = [
    { id: "github", label: t("From GitHub"), kind: "github" },
    { id: "mcp", label: t("MCP server"), kind: "mcp" },
    { id: "api", label: "OpenAPI", kind: "api" },
    { id: "graphql", label: "GraphQL", kind: "graphql" },
    ...sourcePresets.map((preset) => ({
      id: `preset:${preset.id}`,
      label: preset.name,
      kind: "mcp" as const,
      preset,
    })),
  ];

  function startAdding(option: AddCustomOption | undefined) {
    if (!option) return;
    closeDetail();
    setSourceError(null);
    if (option.kind === "github") {
      setSourceKind(null);
      setAdding("github");
    } else beginSource(option.kind, option.preset);
  }

  useLayoutEffect(() => {
    if (!iosAtLeast(26)) return;
    navigation.setOptions({
      unstable_headerRightItems: () => [
        {
          type: "menu" as const,
          label: t("Add custom"),
          accessibilityLabel: t("Add custom"),
          icon: { type: "sfSymbol" as const, name: "plus" },
          menu: {
            items: addOptions.map((option) => ({
              type: "action" as const,
              label: option.label,
              onPress: () => startAdding(option),
            })),
          },
        },
      ],
    } satisfies NativeStackNavigationOptions);
  }, [navigation, sourcePresets, t]);

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        {adding ? (
          <AddCustomForm
            adding={adding}
            gitUrl={gitUrl}
            setGitUrl={setGitUrl}
            onPreviewGit={() => openPlugin(gitImportParams(gitUrl))}
            sourceError={sourceError}
            sourceKind={sourceKind}
            sourcePreset={sourcePreset}
            name={name}
            setName={setName}
            url={url}
            setUrl={setUrl}
            sourceAuth={sourceAuth}
            setSourceAuth={setSourceAuth}
            authHeader={authHeader}
            setAuthHeader={setAuthHeader}
            credential={credential}
            setCredential={setCredential}
            busy={pending === "source"}
            onAdd={() => void addSource()}
            onClose={closeAdding}
          />
        ) : (
          <>
            {!detailItem ? <AddCustomMenu options={addOptions} onSelect={startAdding} /> : null}
            {!detailItem ? (
              <TextInput
                value={query}
                onChangeText={(value) => {
                  setQuery(value);
                  setVisibleCount(CONNECTION_CATALOG_PAGE_SIZE);
                  setPluginCount(PLUGIN_PAGE_SIZE);
                }}
                accessibilityLabel={t("Search apps")}
                placeholder={t("Search apps")}
                placeholderTextColor={native.tertiaryLabel}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                style={styles.input}
              />
            ) : null}

            {!detailItem && (categories.length >= 2 || category) ? (
              <View style={styles.categoryPicker}>
                <MenuPicker
                  label={t("Category")}
                  showLabel={false}
                  plain
                  choices={[
                    { key: "", label: t("All") },
                    ...categories.map((name) => ({ key: name, label: categoryLabel(name) })),
                  ]}
                  value={category}
                  onChange={(key) => {
                    setCategory(key);
                    setPluginCount(PLUGIN_PAGE_SIZE);
                  }}
                />
              </View>
            ) : null}

            {!detailItem && !filtering ? renderConnected() : null}
            {!detailItem && !filtering ? (
              <Pressable
                testID="open-bot-templates"
                accessibilityRole="button"
                onPress={() => router.push("/bot-templates")}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <BotTemplateIcon size={LOGO_SIZE} />
                <Text style={[styles.title, styles.grow]}>{t("Templates")}</Text>
                <Chevron />
              </Pressable>
            ) : null}
            {!detailItem && savedServerMatches.length ? (
              <View testID="connected-apps" style={styles.catalogStack}>
                {savedServerMatches.map(renderSavedServer)}
              </View>
            ) : null}

            {catalogError ? (
              <View style={styles.catalogStack}>
                <Text style={styles.error}>{catalogError}</Text>
                <NativeActionButton
                  label={t("Retry")}
                  fill={false}
                  onPress={() => void retryRefresh()}
                  prominence="secondary"
                />
              </View>
            ) : null}

            {detailItem ? (
              <IntegrationDetail
                item={detailItem}
                accounts={accountsFor(detailItem)}
                pending={pending}
                labelDrafts={labelDrafts}
                setLabelDrafts={setLabelDrafts}
                tools={tools}
                toolsLoading={toolsLoading}
                toolsOpen={toolsOpen}
                setToolsOpen={setToolsOpen}
                onBack={closeDetail}
                onUninstall={() => void uninstall(detailItem)}
                onRename={(row) => void renameAccount(row)}
                onRevoke={(row) => void revokeAccount(row)}
                onConnect={() => void connect(detailItem)}
              />
            ) : (
              <>
                {!catalogReady && !catalogError ? (
                  <View
                    testID="integrations-loading"
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={catalogColumns === 2 ? styles.catalogGrid : styles.catalogStack}
                  >
                    {Array.from({ length: 8 }, (_, index) => (
                      <View
                        key={index}
                        style={[styles.row, catalogColumns === 2 ? styles.catalogCell : null]}
                      >
                        <View style={styles.logoPlaceholder} />
                        <View style={styles.grow}>
                          <View style={styles.titlePlaceholder} />
                        </View>
                        <View style={styles.pillPlaceholder} />
                      </View>
                    ))}
                  </View>
                ) : null}

                {catalogsReady && catalog.length === 0 && plugins.length === 0 && !filtering ? (
                  <Text style={styles.secondary}>{t(EMPTY_PLUGIN_CATALOG_MESSAGE)}</Text>
                ) : null}

                {catalogReady && catalog.length > 0 && !category ? (
                  <View style={catalogColumns === 2 ? styles.catalogGrid : styles.catalogStack}>
                    {showFeatured
                      ? featuredTiles.map((tile) => {
                          const item = tile.item;
                          const key = item ? catalogItemKey(item) : tile.id;
                          const disabled = tile.missing || !item;
                          if (item && !tile.missing) {
                            return renderCatalogTile(item, tile.label);
                          }
                          return (
                            <View
                              key={key}
                              style={[
                                styles.row,
                                catalogColumns === 2 ? styles.catalogCell : null,
                                disabled ? { opacity: 0.7 } : null,
                              ]}
                            >
                              <ConnectorIcon logo={item?.logo} name={tile.label} size={LOGO_SIZE} />
                              <View style={styles.grow}>
                                <Text numberOfLines={1} style={styles.title}>
                                  {tile.label}
                                </Text>
                                {disabled ? (
                                  <Text style={styles.secondary}>
                                    {t("Not in the plugin catalog")}
                                  </Text>
                                ) : null}
                              </View>
                            </View>
                          );
                        })
                      : null}
                    {renderedApps.map((item) => renderCatalogTile(item, item.name))}
                  </View>
                ) : null}

                {catalogsReady &&
                catalogApps.length === 0 &&
                pluginMatches.length === 0 &&
                brandMatches.length === 0 &&
                savedServerMatches.length === 0 &&
                filtering ? (
                  <Text style={styles.secondary}>{t("No apps match your search.")}</Text>
                ) : null}

                {!category && renderedApps.length < catalogApps.length ? (
                  <NativeActionButton
                    label={t("Show more")}
                    onPress={() => setVisibleCount((count) => count + CONNECTION_CATALOG_PAGE_SIZE)}
                    prominence="secondary"
                  />
                ) : null}

                <PluginSection
                  pluginsState={pluginsState}
                  catalogReady={catalogReady}
                  onRetry={() => {
                    setPluginsState("loading");
                    void retryRefresh();
                  }}
                  filtering={filtering}
                  pluginMatches={pluginMatches}
                  brandMatches={brandMatches}
                  pluginCount={pluginCount}
                  onShowMore={() => setPluginCount((count) => count + PLUGIN_PAGE_SIZE)}
                  plugins={plugins}
                  categories={categories}
                  categoryLabel={categoryLabel}
                  onViewCategory={(name) => {
                    setCategory(name);
                    setPluginCount(PLUGIN_PAGE_SIZE);
                  }}
                  installedSources={installedSources}
                  columns={catalogColumns}
                  onOpenPlugin={openPlugin}
                  renderAppTile={(item) => renderCatalogTile(item, item.name)}
                />
                {pluginsState !== "loading" ? (
                  <NativeActionButton
                    fill={false}
                    label={t("Submit a plugin")}
                    onPress={() => void Linking.openURL(SUBMIT_PLUGIN_URL)}
                    prominence="quiet"
                    size="compact"
                    variant="text"
                  />
                ) : null}
              </>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
