import type { CapabilityInstall, Connection, ConnectionCatalogItem } from "@rakazo/contracts";
import {
  abortableDelay,
  buildFeaturedConnectorTiles,
  CONNECTION_CATALOG_PAGE_SIZE,
  EMPTY_PLUGIN_CATALOG_MESSAGE,
  filterConnectionCatalogItems,
  humanizeToolName,
} from "@rakazo/core";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { loadLastBotId } from "../lib/last-bot";
import { native, useThemedStyles } from "../lib/native";

type SourceKind = "treg" | "executor" | "mcp" | "api" | "graphql";
type ConnectionTool = { name: string; description: string };

function itemKey(item: Pick<ConnectionCatalogItem, "connectorId" | "slug">) {
  return `${item.connectorId}:${item.slug}`;
}

export default function Integrations() {
  const styles = useThemedStyles(createIntegrationsStyles);
  const { t } = useI18n();
  const { width } = useWindowDimensions();
  const catalogColumns = width >= 480 ? 2 : 1;
  const [catalog, setCatalog] = useState<ConnectionCatalogItem[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(CONNECTION_CATALOG_PAGE_SIZE);
  const [sources, setSources] = useState<CapabilityInstall[]>([]);
  const [sourceKind, setSourceKind] = useState<SourceKind | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [requiresAuth, setRequiresAuth] = useState(true);
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

  const featuredTiles = useMemo(() => buildFeaturedConnectorTiles(catalog), [catalog]);
  const showFeatured = !query.trim();
  const catalogApps = useMemo(() => filterConnectionCatalogItems(catalog, query), [catalog, query]);
  const renderedApps = catalogApps.slice(0, visibleCount);

  const detailItem = useMemo(() => {
    if (!detailKey) return null;
    return (
      catalog.find(
        (entry) => entry.connectorId === detailKey.connectorId && entry.slug === detailKey.slug,
      ) ?? null
    );
  }, [catalog, detailKey]);

  async function refresh() {
    const catalogResult = await rpc<ConnectionCatalogItem[]>("connections/catalog");
    setCatalog(catalogResult);
    setCatalogReady(true);
    try {
      const rows = await rpc<Connection[]>("connections/list");
      setConnections(rows);
      setLabelDrafts((current) => {
        const next: Record<string, string> = {};
        for (const row of rows) {
          if (row.status === "connected" || row.status === "pending") {
            next[row.id] = current[row.id] ?? row.displayName;
          }
        }
        return next;
      });
    } catch {
      setConnections([]);
      setLabelDrafts({});
    }
    try {
      const installs = await rpc<CapabilityInstall[]>("capabilities/list");
      setSources(
      installs.filter(
        (item) => item.kind === "mcp" || item.kind === "api" || item.kind === "graphql",
      ),
    );
    } catch {
      // Tool sources are optional; keep featured/catalog usable if this fails.
    }
  }

  useEffect(() => {
    void refresh().catch((reason) => {
      setCatalogReady(false);
      setCatalogError(reason instanceof Error ? reason.message : t("Could not load integrations"));
    });
    void loadLastBotId().then(setLastBotId);
    return () => connectionAttempt.current?.abort();
  }, []);

  useEffect(() => {
    if (!detailKey) {
      setTools([]);
      setToolsLoading(false);
      return;
    }
    let cancelled = false;
    setToolsLoading(true);
    void rpc<ConnectionTool[]>("connections/tools", {
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

  function closeAdvanced() {
    setAdvancedOpen(false);
    setSourceKind(null);
    setSourceError(null);
    setName("");
    setUrl("");
    setCredential("");
    setRequiresAuth(true);
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
    return connections.filter(
      (row) =>
        row.connectorId === item.connectorId &&
        row.provider === item.slug &&
        (row.status === "connected" || row.status === "pending"),
    );
  }

  function itemConnected(item: ConnectionCatalogItem) {
    return item.connected || accountsFor(item).some((row) => row.status === "connected");
  }

  async function notifyAppConnected(item: ConnectionCatalogItem) {
    const botId = lastBotId || (await loadLastBotId());
    if (!botId) return;
    if (botId !== lastBotId) setLastBotId(botId);
    void rpc("onboarding/appConnected", { botId, provider: item.slug }).catch(() => undefined);
  }

  async function connect(item: ConnectionCatalogItem) {
    connectionAttempt.current?.abort();
    const controller = new AbortController();
    connectionAttempt.current = controller;
    const key = itemKey(item);
    setPending(key);
    setCatalogError(null);
    try {
      const started = await rpc<{ connectionId: string; authorizationUrl: string | null }>(
        "connections/begin",
        {
          connectorId: item.connectorId,
          provider: item.slug,
          displayName: (() => {
            const count = accountsFor(item).filter((row) => row.status === "connected").length;
            return count <= 0 ? item.name : `${item.name} ${count + 1}`;
          })(),
        },
      );
      if (started.authorizationUrl) await Linking.openURL(started.authorizationUrl);
      for (let attempt = 0; attempt < 45; attempt += 1) {
        if (controller.signal.aborted) return;
        const row = await rpc<Connection>("connections/complete", {
          connectionId: started.connectionId,
        }).catch(() => undefined);
        if (row?.status === "connected") {
          if (controller.signal.aborted) return;
          void notifyAppConnected(item);
          await refresh();
          setToolsTick((tick) => tick + 1);
          return;
        }
        await abortableDelay(2_000, controller.signal);
      }
      if (controller.signal.aborted) return;
      Alert.alert(
        t("Connection pending"),
        t("Finish connecting in the browser, then refresh this page."),
      );
    } catch (reason) {
      if (controller.signal.aborted) return;
      setCatalogError(reason instanceof Error ? reason.message : t("Could not connect"));
    } finally {
      if (connectionAttempt.current === controller) {
        connectionAttempt.current = null;
        setPending(null);
      }
    }
  }

  async function revokeAccount(row: Connection) {
    setPending(row.id);
    setCatalogError(null);
    try {
      await rpc("connections/revoke", { connectionId: row.id });
      await refresh();
      setToolsTick((tick) => tick + 1);
    } catch (reason) {
      setCatalogError(reason instanceof Error ? reason.message : t("Could not revoke connection"));
    } finally {
      setPending(null);
    }
  }

  async function renameAccount(row: Connection) {
    const displayName = (labelDrafts[row.id] ?? row.displayName).trim();
    if (!displayName || displayName === row.displayName) return;
    setPending(`rename:${row.id}`);
    setCatalogError(null);
    try {
      const updated = await rpc<Connection>("connections/rename", {
        connectionId: row.id,
        displayName,
      });
      setConnections((current) =>
        current.map((entry) =>
          entry.id === row.id ? { ...entry, displayName: updated.displayName } : entry,
        ),
      );
      setLabelDrafts((current) => ({ ...current, [row.id]: updated.displayName }));
    } catch (reason) {
      setCatalogError(reason instanceof Error ? reason.message : t("Could not rename connection"));
    } finally {
      setPending(null);
    }
  }

  async function uninstall(item: ConnectionCatalogItem) {
    const matches = accountsFor(item);
    const key = itemKey(item);
    if (matches.length === 0) {
      closeDetail();
      return;
    }
    setPending(`uninstall:${key}`);
    setCatalogError(null);
    try {
      for (const row of matches) {
        await rpc("connections/revoke", { connectionId: row.id });
      }
      await refresh();
      closeDetail();
    } catch (reason) {
      setCatalogError(reason instanceof Error ? reason.message : t("Could not revoke connection"));
      await refresh().catch(() => undefined);
    } finally {
      setPending(null);
    }
  }

  function beginSource(kind: SourceKind) {
    setSourceKind(kind);
    setSourceError(null);
    setName(kind === "treg" ? "Treg" : kind === "executor" ? "Executor" : "");
    setUrl(kind === "treg" ? "https://treg.to/mcp/" : "");
    setCredential("");
    setRequiresAuth(kind === "treg" || kind === "executor");
  }

  async function addSource() {
    if (!sourceKind) return;
    setPending("source");
    setSourceError(null);
    try {
      await rpc("capabilities/install", {
        kind: sourceKind === "treg" || sourceKind === "executor" ? "mcp" : sourceKind,
        name:
          name.trim() ||
          (sourceKind === "treg"
            ? "Treg"
            : sourceKind === "executor"
              ? "Executor"
              : sourceKind === "graphql"
                ? "GraphQL"
                : t("Custom connector")),
        source: url.trim(),
        credential: credential.trim() || undefined,
        config:
          sourceKind === "treg"
            ? { preset: "treg", auth: { type: "bearer" } }
            : sourceKind === "api"
              ? { openApi: true, auth: { type: requiresAuth ? "bearer" : "none" } }
              : sourceKind === "graphql"
                ? { auth: { type: requiresAuth ? "bearer" : "none" } }
                : {
                    preset: "custom",
                    auth: { type: sourceKind === "executor" || requiresAuth ? "bearer" : "none" },
                  },
      });
      setCredential("");
      setSourceKind(null);
      await refresh();
    } catch (reason) {
      setSourceError(reason instanceof Error ? reason.message : t("Could not add source"));
    } finally {
      setPending(null);
    }
  }

  async function removeSource(source: CapabilityInstall) {
    setPending(source.id);
    setSourceError(null);
    try {
      await rpc("capabilities/remove", { id: source.id });
      setSources((current) => current.filter((item) => item.id !== source.id));
    } catch (reason) {
      setSourceError(reason instanceof Error ? reason.message : t("Could not remove source"));
    } finally {
      setPending(null);
    }
  }

  function renderCatalogActions(item: ConnectionCatalogItem, label: string) {
    const key = itemKey(item);
    const connected = itemConnected(item);
    const connecting = pending === key;
    if (connected) {
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Added")}
          disabled={connecting}
          onPress={() => openDetail(item)}
        >
          <Text style={styles.link}>{connecting ? t("Working…") : t("Added")}</Text>
        </Pressable>
      );
    }
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Add {name}", { name: label })}
        disabled={connecting}
        onPress={() => void connect(item)}
      >
        <Text style={styles.link}>{connecting ? t("Working…") : t("Add")}</Text>
      </Pressable>
    );
  }

  function renderCatalogTile(item: ConnectionCatalogItem, label: string) {
    const connected = itemConnected(item);
    const body = (
      <>
        <View style={styles.grow}>
          <Text numberOfLines={1} style={styles.title}>
            {label}
          </Text>
        </View>
        {renderCatalogActions(item, label)}
      </>
    );
    const tileStyle = [styles.row, catalogColumns === 2 ? styles.catalogCell : null];
    if (connected) {
      return (
        <Pressable
          key={itemKey(item)}
          accessibilityRole="button"
          onPress={() => openDetail(item)}
          style={tileStyle}
        >
          {body}
        </Pressable>
      );
    }
    return (
      <View key={itemKey(item)} style={tileStyle}>
        {body}
      </View>
    );
  }

  function renderDetail(item: ConnectionCatalogItem) {
    const accounts = accountsFor(item);
    const key = itemKey(item);
    const connecting = pending === key;
    const uninstalling = pending === `uninstall:${key}`;
    const toolCount = tools.length;

    return (
      <View style={styles.detail}>
        <View style={styles.detailHeader}>
          <View style={styles.detailTitleRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Back")}
              onPress={closeDetail}
              style={styles.backButton}
            >
              <Text style={styles.link}>{t("Back")}</Text>
            </Pressable>
            <Text numberOfLines={1} style={styles.detailTitle}>
              {item.name}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Uninstall")}
            disabled={uninstalling || connecting}
            onPress={() => void uninstall(item)}
          >
            <Text style={styles.link}>{uninstalling ? t("Working…") : t("Uninstall")}</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.section}>{t("Accounts")}</Text>
          {accounts.map((row) => (
            <View key={row.id} style={styles.accountRow}>
              <TextInput
                value={labelDrafts[row.id] ?? row.displayName}
                onChangeText={(value) =>
                  setLabelDrafts((current) => ({ ...current, [row.id]: value }))
                }
                onEndEditing={() => void renameAccount(row)}
                accessibilityLabel={t("Account label")}
                style={styles.accountLabel}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Remove {name}", { name: row.displayName })}
                disabled={pending === row.id || uninstalling}
                onPress={() => void revokeAccount(row)}
              >
                <Text style={styles.link}>{pending === row.id ? t("Working…") : t("Remove")}</Text>
              </Pressable>
            </View>
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Add another {name}", { name: item.name })}
            disabled={connecting || uninstalling}
            onPress={() => void connect(item)}
            style={styles.cardButton}
          >
            <Text style={styles.buttonLabel}>{connecting ? t("Working…") : t("Add another")}</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: toolsOpen }}
            onPress={() => setToolsOpen((open) => !open)}
            style={styles.toolsToggle}
          >
            <Text style={styles.title}>
              {toolsLoading
                ? t("Tools")
                : toolCount === 1
                  ? t("1 tool")
                  : t("{count} tools", { count: toolCount })}
            </Text>
            <Text style={styles.chevron}>{toolsOpen ? "˅" : "›"}</Text>
          </Pressable>
          {toolsOpen ? (
            <View style={styles.toolsBody}>
              {toolsLoading ? (
                <Text style={styles.secondary}>{t("Loading tools…")}</Text>
              ) : tools.length === 0 ? (
                <Text style={styles.secondary}>{t("No tools available.")}</Text>
              ) : (
                tools.map((tool) => (
                  <Text key={tool.name} style={styles.toolName}>
                    {humanizeToolName(tool.name)}
                  </Text>
                ))
              )}
            </View>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        {!detailItem ? <Text style={styles.explanation}>{t("Connect apps.")}</Text> : null}

        {!detailItem ? (
          <TextInput
            value={query}
            onChangeText={(value) => {
              setQuery(value);
              setVisibleCount(CONNECTION_CATALOG_PAGE_SIZE);
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

        {catalogError ? <Text style={styles.error}>{catalogError}</Text> : null}

        {detailItem ? (
          renderDetail(detailItem)
        ) : (
          <>
            {!catalogReady ? <ActivityIndicator color={native.fillPressed} /> : null}

            {catalogReady && catalog.length === 0 ? (
              <Text style={styles.secondary}>{t(EMPTY_PLUGIN_CATALOG_MESSAGE)}</Text>
            ) : null}

            {catalogReady && catalog.length > 0 ? (
              <View style={catalogColumns === 2 ? styles.catalogGrid : styles.catalogStack}>
                {showFeatured
                  ? featuredTiles.map((tile) => {
                      const item = tile.item;
                      const key = item ? itemKey(item) : tile.id;
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
                          <View style={styles.grow}>
                            <Text numberOfLines={1} style={styles.title}>
                              {tile.label}
                            </Text>
                            {disabled ? (
                              <Text style={styles.secondary}>{t("Not in the plugin catalog")}</Text>
                            ) : null}
                          </View>
                        </View>
                      );
                    })
                  : null}
                {renderedApps.map((item) => renderCatalogTile(item, item.name))}
              </View>
            ) : null}

            {catalogReady && catalog.length > 0 && catalogApps.length === 0 && !showFeatured ? (
              <Text style={styles.secondary}>{t("No apps match your search.")}</Text>
            ) : null}

            {renderedApps.length < catalogApps.length ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setVisibleCount((count) => count + CONNECTION_CATALOG_PAGE_SIZE)}
                style={styles.smallButton}
              >
                <Text style={styles.buttonLabel}>{t("Show more")}</Text>
              </Pressable>
            ) : null}

            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: advancedOpen }}
              testID="integrations-advanced"
              onPress={() => {
                if (advancedOpen) closeAdvanced();
                else setAdvancedOpen(true);
              }}
              style={styles.advancedToggle}
            >
              <Text style={styles.advancedLabel}>{t("Advanced")}</Text>
              <Text style={styles.chevron}>›</Text>
            </Pressable>

            {advancedOpen ? (
              <View style={styles.advancedBody}>
                <View style={styles.accountActions}>
                  {(["mcp", "api", "graphql", "executor", "treg"] as const).map((kind) => (
                    <Pressable
                      key={kind}
                      accessibilityRole="button"
                      onPress={() => beginSource(kind)}
                      style={styles.smallButton}
                    >
                      <Text style={styles.buttonLabel}>
                        {kind === "treg"
                          ? t("Add Treg")
                          : kind === "executor"
                            ? t("Add Executor")
                            : kind === "mcp"
                              ? t("Add MCP server")
                              : kind === "graphql"
                                ? t("Add GraphQL")
                                : t("Add OpenAPI")}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {sourceError ? <Text style={styles.error}>{sourceError}</Text> : null}

                {sourceKind ? (
                  <View style={styles.card}>
                    <Text style={styles.title}>
                      {sourceKind === "treg"
                        ? t("Connect Treg")
                        : sourceKind === "executor"
                          ? t("Connect Executor")
                          : sourceKind === "mcp"
                            ? t("Remote MCP server")
                            : sourceKind === "graphql"
                              ? t("GraphQL endpoint")
                              : t("OpenAPI JSON")}
                    </Text>
                    <TextInput
                      value={name}
                      onChangeText={setName}
                      placeholder={t("Display name")}
                      placeholderTextColor={native.tertiaryLabel}
                      style={styles.input}
                    />
                    {sourceKind !== "treg" ? (
                      <TextInput
                        value={url}
                        onChangeText={setUrl}
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder={
                          sourceKind === "mcp"
                            ? t("https://example.com/mcp")
                            : sourceKind === "executor"
                              ? t("https://executor.example/mcp")
                              : sourceKind === "graphql"
                                ? t("https://example.com/graphql")
                                : t("https://example.com/openapi.json")
                        }
                        placeholderTextColor={native.tertiaryLabel}
                        style={styles.input}
                      />
                    ) : null}
                    {sourceKind !== "treg" && sourceKind !== "executor" ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setRequiresAuth((value) => !value)}
                        style={styles.authToggle}
                      >
                        <Text style={styles.secondary}>
                          {requiresAuth ? t("Bearer authentication") : t("No authentication")}
                        </Text>
                      </Pressable>
                    ) : null}
                    {sourceKind === "treg" || sourceKind === "executor" || requiresAuth ? (
                      <TextInput
                        value={credential}
                        onChangeText={setCredential}
                        secureTextEntry
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder={
                          sourceKind === "treg"
                            ? t("Treg token")
                            : sourceKind === "executor"
                              ? t("Executor token")
                              : t("Bearer token")
                        }
                        placeholderTextColor={native.tertiaryLabel}
                        style={styles.input}
                      />
                    ) : null}
                    <View style={styles.accountActions}>
                      <Pressable
                        accessibilityRole="button"
                        disabled={pending === "source"}
                        onPress={() => void addSource()}
                        style={styles.smallButton}
                      >
                        {pending === "source" ? (
                          <ActivityIndicator color={native.label} />
                        ) : (
                          <Text style={styles.buttonLabel}>{t("Verify and add")}</Text>
                        )}
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setSourceKind(null)}
                        style={styles.smallButton}
                      >
                        <Text style={styles.buttonLabel}>{t("Cancel")}</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null}

                <Text style={styles.section}>{t("Tool sources")}</Text>
                {sources.length === 0 ? (
                  <Text style={styles.secondary}>{t("No custom sources installed.")}</Text>
                ) : null}
                {sources.map((source) => (
                  <View key={source.id} style={styles.row}>
                    <View style={styles.grow}>
                      <Text style={styles.title}>{source.name}</Text>
                      <Text numberOfLines={1} style={styles.secondary}>
                        {source.kind.toUpperCase()} · {source.source}
                      </Text>
                    </View>
                    <Pressable accessibilityRole="button" onPress={() => void removeSource(source)}>
                      <Text style={styles.remove}>
                        {pending === source.id ? t("Removing…") : t("Remove")}
                      </Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function createIntegrationsStyles() {
  const destructive = mobileTokens().destructive;
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 14 },
    explanation: { color: native.secondaryLabel, fontSize: 14, lineHeight: 20 },
    section: { color: native.secondaryLabel, fontSize: 14, fontWeight: "600", marginTop: 2 },
    smallButton: {
      minHeight: 42,
      paddingHorizontal: 14,
      borderRadius: 12,
      backgroundColor: native.fill,
      alignItems: "center",
      justifyContent: "center",
    },
    cardButton: {
      alignSelf: "flex-start",
      minHeight: 42,
      paddingHorizontal: 14,
      borderRadius: 12,
      backgroundColor: native.fillPressed,
      alignItems: "center",
      justifyContent: "center",
    },
    buttonLabel: { color: native.label, fontSize: 14, fontWeight: "600" },
    card: { padding: 16, borderRadius: 16, backgroundColor: native.fill, gap: 12 },
    input: {
      minHeight: 48,
      borderRadius: 12,
      backgroundColor: native.fillPressed,
      color: native.label,
      paddingHorizontal: 14,
      fontSize: 15,
    },
    authToggle: { minHeight: 42, justifyContent: "center" },
    catalogGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    catalogStack: { gap: 8 },
    catalogCell: { flexGrow: 1, flexBasis: "47%", maxWidth: "49%" },
    row: {
      minHeight: 56,
      paddingHorizontal: 12,
      paddingVertical: 12,
      borderRadius: 14,
      backgroundColor: native.fill,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    grow: { flex: 1, gap: 3, minWidth: 0 },
    title: { color: native.label, fontSize: 15, fontWeight: "600" },
    secondary: { color: native.secondaryLabel, fontSize: 13 },
    accountActions: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 8,
    },
    accountRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    accountLabel: {
      flex: 1,
      minHeight: 36,
      borderRadius: 10,
      backgroundColor: native.fillPressed,
      color: native.label,
      paddingHorizontal: 10,
      fontSize: 13,
    },
    link: { color: native.label, fontSize: 14, fontWeight: "600" },
    remove: { color: destructive, fontSize: 14, fontWeight: "600" },
    error: { color: destructive, fontSize: 14 },
    detail: { gap: 14 },
    detailHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    detailTitleRow: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minWidth: 0 },
    backButton: { paddingVertical: 4 },
    detailTitle: { flex: 1, color: native.label, fontSize: 17, fontWeight: "600" },
    toolsToggle: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    toolsBody: { gap: 8, paddingTop: 4 },
    toolName: { color: native.label, fontSize: 14 },
    advancedToggle: {
      marginTop: 8,
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    advancedLabel: { color: native.secondaryLabel, fontSize: 14 },
    advancedBody: { gap: 14 },
    chevron: { color: native.secondaryLabel, fontSize: 18 },
  });
}
