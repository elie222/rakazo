import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { CapabilityInstall, ConnectionCatalogItem } from "@rakazo/contracts";
import { SUBMIT_PLUGIN_URL } from "@rakazo/contracts";
import {
  addedMcpEndpoints,
  browsablePlugins,
  buildFeaturedConnectorTiles,
  CONNECTION_CATALOG_PAGE_SIZE,
  catalogItemAccounts,
  catalogItemKey,
  featuredMcpPresets,
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
import { selectedSpaceId } from "../../lib/api/api";
import { errorText } from "../../lib/api/user-error";
import { loadLastBotId } from "../../lib/inbox/last-bot";
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
import { queryClient, rpcQuery } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";

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
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(CONNECTION_CATALOG_PAGE_SIZE);
  const [category, setCategory] = useState("");
  const [pluginCount, setPluginCount] = useState(PLUGIN_PAGE_SIZE);
  const [oauthServerId, setOauthServerId] = useState<string | null>(null);
  const [lastBotId, setLastBotId] = useState("");
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [openApp, setOpenApp] = useState<{
    connectorId: string;
    slug: string;
    spaceId: string | null;
  } | null>(null);
  const spaceId = selectedSpaceId();
  // An app opened in one Space closes on switching to another, with its unsaved label edits.
  if (openApp && openApp.spaceId !== spaceId) {
    setOpenApp(null);
    setLabelDrafts({});
  }
  const detailKey = openApp?.spaceId === spaceId ? openApp : null;
  const [toolsOpen, setToolsOpen] = useState(true);

  const catalogRead = rpcQuery("connections/catalog");
  const listRead = rpcQuery("connections/list");
  const connectionsRead = {
    ...listRead,
    queryFn: async (context: Parameters<typeof listRead.queryFn>[0]) => {
      // The catalog call reconciles connection rows, so they are listed after it answers.
      await queryClient.fetchQuery({ ...catalogRead, staleTime: 0 });
      return listRead.queryFn(context);
    },
  };
  const serversRead = rpcQuery("mcp/servers/list");
  const installsRead = rpcQuery("capabilities/list");
  const presetsRead = rpcQuery("capabilities/sourcePresets");
  const marketplaceRead = rpcQuery("marketplace/catalog", { query: "" });
  const toolsRead = rpcQuery(
    "connections/tools",
    detailKey
      ? { connectorId: detailKey.connectorId, provider: detailKey.slug }
      : { connectorId: "", provider: "" },
  );
  const catalogQuery = useScreenQuery(catalogRead);
  const connectionsQuery = useScreenQuery(connectionsRead);
  const serversQuery = useScreenQuery(serversRead);
  const installsQuery = useScreenQuery(installsRead);
  const presetsQuery = useScreenQuery(presetsRead);
  const marketplaceQuery = useScreenQuery(marketplaceRead);
  const toolsQuery = useScreenQuery(toolsRead, { enabled: Boolean(detailKey) });
  const screenQueries = [
    catalogQuery,
    connectionsQuery,
    serversQuery,
    installsQuery,
    presetsQuery,
    marketplaceQuery,
  ];
  /** What any change on this screen makes out of date: every list on it, and an app's tools. */
  const stale = [
    ...[catalogRead, listRead, serversRead, installsRead, presetsRead, marketplaceRead].map(
      (read) => read.queryKey,
    ),
    toolsRead.queryKey.slice(0, -1),
  ];

  const catalog = catalogQuery.data ?? [];
  const connections = connectionsQuery.data ?? [];
  const catalogReady = catalogQuery.data !== undefined && connectionsQuery.data !== undefined;
  const mcpServers = serversQuery.data ?? [];
  const installs = installsQuery.data ?? [];
  const sources = installs.filter(
    (item) => item.kind === "mcp" || item.kind === "api" || item.kind === "graphql",
  );
  const addedEndpoints = addedMcpEndpoints(sources, mcpServers);
  const pluginInstalls = installs.filter((item) => item.kind === "plugin");
  // A server without presets (or a failed request) offers none, never another server's.
  const sourcePresets = presetsQuery.data ?? [];
  const pluginEntries = marketplaceQuery.data?.entries ?? [];
  const pluginsState =
    (!marketplaceQuery.data && !marketplaceQuery.isError) ||
    (marketplaceQuery.isError && marketplaceQuery.isFetching)
      ? "loading"
      : marketplaceQuery.isError || marketplaceQuery.data?.unavailableRegistries.length
        ? "partial"
        : "ready";
  const tools = toolsQuery.data ?? [];
  const toolsLoading = Boolean(detailKey) && toolsQuery.isLoading;

  function refresh() {
    for (const screenQuery of screenQueries) void screenQuery.refetch({ cancelRefetch: false });
  }

  const {
    connect,
    revokeAccount,
    renameAccount,
    uninstall,
    authorizeMcp,
    stopConnecting,
    resetFailures,
    pending: accountPending,
    failure,
    mcpFailure,
    resetMcpFailure,
  } = useConnectionActions({
    catalogRead,
    connectionsRead,
    stale,
    connections,
    labelDrafts,
    setLabelDrafts,
    lastBotId,
    setLastBotId,
    closeDetail,
    captureFocus,
  });
  const {
    addOptions,
    adding,
    startAdding,
    startCatalogMcp,
    removeSource,
    pending: sourcePending,
    formProps,
  } = useCustomSourceForm({
    sourcePresets: sourcePresets.filter(({ url }) => !url || !addedEndpoints.has(url)),
    stale,
    authorizeMcp,
    setOauthServerId,
    captureFocus,
    onStart: () => closeDetail(),
  });
  const pending = accountPending ?? sourcePending;
  const loadFailure = catalogQuery.error ?? connectionsQuery.error;
  const catalogError =
    failure ?? (loadFailure ? errorText(loadFailure, t`Could not load integrations`) : null);
  const mcpError =
    mcpFailure ??
    (serversQuery.error ? errorText(serversQuery.error, t`Could not load MCP servers`) : null);

  function retry() {
    resetFailures();
    resetMcpFailure();
    refresh();
  }

  // Counted per focus, so work started before the screen was left never acts on a later visit.
  const focus = useRef({ shown: false, visit: 0 });
  function captureFocus() {
    const visit = focus.current.visit;
    return () => focus.current.shown && focus.current.visit === visit;
  }
  useFocusEffect(
    useCallback(() => {
      focus.current = { shown: true, visit: focus.current.visit + 1 };
      let cancelled = false;
      void loadLastBotId().then((id) => {
        if (!cancelled) setLastBotId(id);
      });
      return () => {
        cancelled = true;
        focus.current = { ...focus.current, shown: false };
        stopConnecting();
      };
    }, [stopConnecting]),
  );

  const catalogsReady = integrationCatalogsReady({
    catalogLoaded: catalogReady,
    catalogFailed: !!catalogError,
    pluginsLoaded: pluginsState !== "loading",
    pluginsUnavailable: pluginsState === "partial",
  });
  const featuredTiles = useMemo(() => buildFeaturedConnectorTiles(catalog), [catalog]);
  const directReady =
    !catalogQuery.isPending && !installsQuery.isPending && !serversQuery.isPending;
  const directPresets =
    category || !directReady
      ? []
      : featuredMcpPresets(sourcePresets, query).filter(
          ({ name }) => !catalog.some((item) => item.name.toLowerCase() === name.toLowerCase()),
        );
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
    resetFailures();
    setToolsOpen(true);
    setOpenApp({ connectorId: item.connectorId, slug: item.slug, spaceId: selectedSpaceId() });
  }

  function closeDetail(item?: ConnectionCatalogItem) {
    setOpenApp((open) =>
      !item || (open?.connectorId === item.connectorId && open.slug === item.slug) ? null : open,
    );
  }

  function itemConnected(item: ConnectionCatalogItem) {
    return isCatalogItemConnected(connections, item);
  }

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
        onPress={() => connect(item)}
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
  }, [navigation, presetsQuery.data, installsQuery.data, serversQuery.data, t]);

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
                onAuthorize={authorizeMcp}
                onRetry={retry}
                onRemoveSource={removeSource}
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
                    onAuthorize={authorizeMcp}
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
                  onPress={retry}
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
                onBack={() => closeDetail()}
                onUninstall={() => uninstall(detailItem)}
                onRename={renameAccount}
                onRevoke={revokeAccount}
                onConnect={() => connect(detailItem)}
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
                  >{t`Managed apps haven’t been enabled on this server.`}</Text>
                ) : null}

                {directPresets
                  .filter(
                    ({ url }) =>
                      !url ||
                      !(showFeatured
                        ? addedEndpoints.has(url)
                        : savedServerMatches.some(({ endpoint }) => endpoint === url)),
                  )
                  .map((preset) => (
                    <View key={preset.id} style={styles.row}>
                      <ConnectorIcon name={preset.name} size={LOGO_SIZE} />
                      <Text numberOfLines={1} style={[styles.title, styles.grow]}>
                        {preset.name}
                      </Text>
                      {preset.url && addedEndpoints.has(preset.url) ? (
                        <Text style={styles.secondary}>{t`Added`}</Text>
                      ) : (
                        <NativeActionButton
                          fill={false}
                          label={t`Connect`}
                          accessibilityLabel={t`Connect ${ph({ name: preset.name })}`}
                          onPress={() =>
                            startAdding({ id: preset.id, label: preset.name, kind: "mcp", preset })
                          }
                          prominence="secondary"
                        />
                      )}
                    </View>
                  ))}

                {catalogReady && catalog.length > 0 && !category ? (
                  <View style={catalogColumns === 2 ? styles.catalogGrid : styles.catalogStack}>
                    {showFeatured
                      ? featuredTiles.map((tile) => {
                          const item = tile.item;
                          if (!item && directPresets.some(({ name }) => name === tile.label))
                            return null;
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
                {catalogsReady && directReady ? (
                  <IntegrationCatalogSearch
                    query={query}
                    hidden={Boolean(category)}
                    noLocalMatch={noMatch && directPresets.length === 0}
                    excludedNames={[...catalog, ...directPresets].map(({ name }) => name)}
                    addedEndpoints={addedEndpoints}
                    onOpenMcp={startCatalogMcp}
                    onChanged={(serverId) => {
                      if (serverId) setOauthServerId(serverId);
                      refresh();
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
                  onRetry={refresh}
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
