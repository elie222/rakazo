import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type {
  CapabilityInstall,
  Connection,
  ConnectionCatalogItem,
  McpServer,
  McpSourcePreset,
  PluginMarketplaceEntry,
} from "@rakazo/contracts";
import { SUBMIT_PLUGIN_URL } from "@rakazo/contracts";
import {
  browsablePlugins,
  buildFeaturedConnectorTiles,
  CONNECTION_CATALOG_PAGE_SIZE,
  catalogItemAccounts,
  catalogItemKey,
  filterConnectionCatalogItems,
  filterPluginBrands,
  filterPlugins,
  integrationCatalogsReady,
  isCatalogItemConnected,
  matchesWordPrefixes,
  pluginBrands,
  pluginCategories,
} from "@rakazo/core";
import { pluginCategoryLabel } from "@rakazo/i18n/plugin-catalog";
import type { NativeStackNavigationOptions } from "expo-router";
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BotTemplateIcon } from "../../components/bots/bot-template-icon";
import { AddCustomForm, AddCustomMenu } from "../../components/integrations/add-custom-integration";
import { ConnectedApps, SavedServerRow } from "../../components/integrations/connected-apps";
import { ConnectorIcon } from "../../components/integrations/connector-icon";
import { IntegrationCatalogSearch } from "../../components/integrations/integration-catalog-search";
import type { ConnectionTool } from "../../components/integrations/integration-detail";
import { IntegrationDetail } from "../../components/integrations/integration-detail";
import { PLUGIN_PAGE_SIZE, PluginSection } from "../../components/integrations/integration-plugins";
import {
  createIntegrationsStyles,
  LOGO_SIZE,
} from "../../components/integrations/integrations-styles";
import { useConnectionActions } from "../../components/integrations/use-connection-actions";
import { useCustomSourceForm } from "../../components/integrations/use-custom-source-form";
import { NativeActionButton } from "../../components/native/native-action-button";
import { MenuPicker } from "../../components/ui/menu-picker";
import { Chevron } from "../../components/ui/row-accessories";
import { rpc } from "../../lib/api/api";
import { errorText } from "../../lib/api/user-error";
import { loadLastBotId } from "../../lib/inbox/last-bot";
import type {
  IntegrationsCacheScope,
  IntegrationsSnapshot,
} from "../../lib/integrations/integrations-cache";
import {
  integrationsCacheScope,
  isIntegrationsScopeCurrent,
  persistedIntegrationsCacheScope,
  readIntegrationsCache,
  writeIntegrationsCache,
} from "../../lib/integrations/integrations-cache";
import type { PluginParams } from "../../lib/integrations/plugin-marketplace";
import {
  gitImportParams,
  hasPluginConnector,
  managedPluginParams,
  pluginParams,
} from "../../lib/integrations/plugin-marketplace";
import { useSideInsets } from "../../lib/layout/side-insets";
import { native, useThemedStyles } from "../../lib/native/native";
import { iosAtLeast } from "../../lib/native/native-controls";
import { openExternalUrl } from "../../lib/platform/open-url";

export default function Integrations() {
  const sideInsets = useSideInsets();
  const router = useRouter();
  // A merged brand's plugin page sends people back here to manage the app's accounts.
  const { app: appToOpen } = useLocalSearchParams<{ app?: string }>();
  const navigation = useNavigation();
  const styles = useThemedStyles(createIntegrationsStyles);
  const { t } = useLingui();
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
  const [sourcePresets, setSourcePresets] = useState<McpSourcePreset[]>([]);
  const [oauthServerId, setOauthServerId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [lastBotId, setLastBotId] = useState("");
  const [catalogReady, setCatalogReady] = useState(false);
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [detailKey, setDetailKey] = useState<{ connectorId: string; slug: string } | null>(null);
  const [tools, setTools] = useState<ConnectionTool[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(true);
  const [toolsTick, setToolsTick] = useState(0);
  const connectionAttempt = useRef<AbortController | null>(null);

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
  const mergedBrands = pluginBrands(catalog, pluginForApp);
  const categories = pluginCategories([...plugins, ...mergedBrands.map(({ entry }) => entry)]);
  const brandMatches = filterPluginBrands(
    mergedBrands,
    query,
    category || null,
    pluginCategoryLabel,
  );
  const pluginMatches = filterPlugins(plugins, query, category || null, pluginCategoryLabel);
  const filtering = Boolean(query.trim() || category);
  const installedSources = new Set(pluginInstalls.map((install) => install.source));
  const standaloneServers = mcpServers.filter((server) => !server.installId);
  const savedServerMatches =
    query.trim() && !category
      ? standaloneServers.filter((server) =>
          matchesWordPrefixes(`${server.name} ${server.description}`, query),
        )
      : [];
  const noMatch =
    catalogsReady &&
    filtering &&
    catalogApps.length + pluginMatches.length + brandMatches.length + savedServerMatches.length ===
      0;
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
          setMcpError(errorText(reason, t`Could not load MCP servers`));
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

  async function retryRefresh(isCurrent?: () => boolean) {
    const focus = focusGeneration.current;
    try {
      await refresh();
    } catch (reason) {
      if (
        (!isCurrent || isCurrent()) &&
        mounted.current &&
        focus === focusGeneration.current &&
        (!cacheScope.current || isIntegrationsScopeCurrent(cacheScope.current))
      ) {
        setCatalogError(errorText(reason, t`Could not load integrations`));
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

  function openDetail(item: ConnectionCatalogItem) {
    setCatalogError(null);
    setToolsOpen(true);
    setDetailKey({ connectorId: item.connectorId, slug: item.slug });
  }

  function closeDetail() {
    setDetailKey(null);
    setTools([]);
  }

  function itemConnected(item: ConnectionCatalogItem) {
    return isCatalogItemConnected(connections, item);
  }

  const { connect, revokeAccount, renameAccount, uninstall, authorizeMcp } = useConnectionActions({
    connections,
    labelDrafts,
    setLabelDrafts,
    lastBotId,
    setLastBotId,
    connectionAttempt,
    captureConnectionScope,
    updateAccount,
    refresh,
    retryRefresh,
    setPending,
    setCatalogError,
    setMcpError,
    onToolsChanged: () => setToolsTick((tick) => tick + 1),
    closeDetail,
  });
  const { addOptions, adding, startAdding, removeSource, formProps } = useCustomSourceForm({
    sourcePresets,
    captureConnectionScope,
    retryRefresh,
    authorizeMcp,
    setPending,
    setSources,
    setOauthServerId,
    onStart: closeDetail,
  });

  function renderCatalogActions(item: ConnectionCatalogItem, label: string) {
    const key = catalogItemKey(item);
    const connected = itemConnected(item);
    const connecting = pending === key;
    if (connected) {
      return (
        <NativeActionButton
          accessibilityLabel={t`Added`}
          disabled={connecting}
          fill={false}
          label={connecting ? t`Working…` : t`Added`}
          onPress={() => openDetail(item)}
          prominence="secondary"
        />
      );
    }
    return (
      <NativeActionButton
        accessibilityLabel={t`Add ${ph({ name: label })}`}
        disabled={connecting}
        fill={false}
        label={connecting ? t`Working…` : t`Add`}
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
          {item.chatApp && !connected ? (
            <Text style={styles.secondary}>
              {t`Tools for your bot.`}{" "}
              <Text
                accessibilityRole="link"
                onPress={() => router.push("/messaging")}
                style={styles.inlineLink}
              >
                {t`Chat from ${ph({ name: label })}`}
              </Text>
            </Text>
          ) : null}
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

  useLayoutEffect(() => {
    if (!iosAtLeast(26)) return;
    navigation.setOptions({
      unstable_headerRightItems: () => [
        {
          type: "menu" as const,
          label: t`Add custom`,
          accessibilityLabel: t`Add custom`,
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
            {...formProps}
            adding={adding}
            onPreviewGit={() => openPlugin(gitImportParams(formProps.gitUrl))}
            busy={pending === "source"}
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
                accessibilityLabel={t`Search apps`}
                placeholder={t`Search apps`}
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
                  label={t`Category`}
                  showLabel={false}
                  plain
                  choices={[
                    { key: "", label: t`All` },
                    ...categories.map((name) => ({ key: name, label: pluginCategoryLabel(name) })),
                  ]}
                  value={category}
                  onChange={(key) => {
                    setCategory(key);
                    setPluginCount(PLUGIN_PAGE_SIZE);
                  }}
                />
              </View>
            ) : null}

            {!detailItem && !filtering ? (
              <ConnectedApps
                connectorPlugins={connectorPlugins}
                mcpServers={mcpServers}
                standaloneServers={standaloneServers}
                sources={sources}
                mcpError={mcpError}
                pending={pending}
                oauthServerId={oauthServerId}
                pluginParamsFor={installedParams}
                onOpenPlugin={openPlugin}
                onAuthorize={(serverId) => void authorizeMcp(serverId)}
                onRetry={() => void retryRefresh()}
                onRemoveSource={(source) => void removeSource(source)}
              />
            ) : null}
            {!detailItem && !filtering ? (
              <Pressable
                testID="open-bot-templates"
                accessibilityRole="button"
                onPress={() => router.push("/bot-templates")}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <BotTemplateIcon size={LOGO_SIZE} />
                <Text style={[styles.title, styles.grow]}>{t`Templates`}</Text>
                <Chevron />
              </Pressable>
            ) : null}
            {!detailItem && savedServerMatches.length ? (
              <View testID="connected-apps" style={styles.catalogStack}>
                {savedServerMatches.map((server) => (
                  <SavedServerRow
                    key={server.id}
                    server={server}
                    pending={pending}
                    oauthServerId={oauthServerId}
                    onAuthorize={(serverId) => void authorizeMcp(serverId)}
                  />
                ))}
              </View>
            ) : null}

            {catalogError ? (
              <View style={styles.catalogStack}>
                <Text style={styles.error}>{catalogError}</Text>
                <NativeActionButton
                  label={t`Retry`}
                  fill={false}
                  onPress={() => void retryRefresh()}
                  prominence="secondary"
                />
              </View>
            ) : null}

            {detailItem ? (
              <IntegrationDetail
                item={detailItem}
                accounts={catalogItemAccounts(connections, detailItem)}
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
                onOpenChatApp={() => router.push("/messaging")}
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
                  <Text
                    style={styles.secondary}
                  >{t`Configure a plugin catalog on the server to connect apps.`}</Text>
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
                                    {t`Not in the plugin catalog`}
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

                {noMatch && category ? (
                  <Text style={styles.secondary}>{t`No apps match your search.`}</Text>
                ) : null}
                {catalogsReady ? (
                  <IntegrationCatalogSearch
                    query={query}
                    hidden={Boolean(category)}
                    noLocalMatch={noMatch}
                    onChanged={(serverId) => {
                      if (serverId) setOauthServerId(serverId);
                      void retryRefresh();
                    }}
                  />
                ) : null}

                {!category && renderedApps.length < catalogApps.length ? (
                  <NativeActionButton
                    label={t`Show more`}
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
                  categoryLabel={pluginCategoryLabel}
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
                    label={t`Submit a plugin`}
                    onPress={() => void openExternalUrl(SUBMIT_PLUGIN_URL)}
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
