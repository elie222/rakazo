import type { CapabilityInstall, Connection, ConnectionCatalogItem } from "@rakazo/contracts";
import {
  abortableDelay,
  buildFeaturedConnectorTiles,
  CONNECTION_CATALOG_PAGE_SIZE,
  EMPTY_PLUGIN_CATALOG_MESSAGE,
  filterConnectionCatalogItems,
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
import { ConnectorIcon } from "../components/connector-icon";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { loadLastBotId } from "../lib/last-bot";
import { native, useThemedStyles } from "../lib/native";

type SourceKind = "treg" | "mcp" | "api";

export default function Integrations() {
  const styles = useThemedStyles(createIntegrationsStyles);
  const { t } = useI18n();
  const { width } = useWindowDimensions();
  const catalogColumns = width >= 480 ? 2 : 1;
  const [catalog, setCatalog] = useState<ConnectionCatalogItem[]>([]);
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
  const connectionAttempt = useRef<AbortController | null>(null);

  const featuredTiles = useMemo(() => buildFeaturedConnectorTiles(catalog), [catalog]);
  const showFeatured = !query.trim();
  const catalogApps = useMemo(() => filterConnectionCatalogItems(catalog, query), [catalog, query]);
  const renderedApps = catalogApps.slice(0, visibleCount);

  async function refresh() {
    const catalogResult = await rpc<ConnectionCatalogItem[]>("connections/catalog");
    setCatalog(catalogResult);
    setCatalogReady(true);
    try {
      const installs = await rpc<CapabilityInstall[]>("capabilities/list");
      setSources(installs.filter((item) => item.kind === "mcp" || item.kind === "api"));
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

  function closeAdvanced() {
    setAdvancedOpen(false);
    setSourceKind(null);
    setSourceError(null);
    setName("");
    setUrl("");
    setCredential("");
    setRequiresAuth(true);
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
    const key = `${item.connectorId}:${item.slug}`;
    setPending(key);
    setCatalogError(null);
    try {
      const started = await rpc<{ connectionId: string; authorizationUrl: string | null }>(
        "connections/begin",
        {
          connectorId: item.connectorId,
          provider: item.slug,
          displayName: item.name,
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

  async function revoke(item: ConnectionCatalogItem) {
    const key = `${item.connectorId}:${item.slug}`;
    setPending(key);
    setCatalogError(null);
    const connections = await rpc<Connection[]>("connections/list").catch(() => []);
    const matches = connections.filter(
      (connection) =>
        connection.connectorId === item.connectorId && connection.provider === item.slug,
    );
    try {
      const row =
        matches.find((connection) => connection.status === "connected") ??
        matches.find((connection) => connection.status === "pending") ??
        matches.find((connection) => connection.status === "error");
      if (!row) throw new Error(t("No connection record found for {name}.", { name: item.name }));
      await rpc("connections/revoke", { connectionId: row.id });
      await refresh();
    } catch (reason) {
      setCatalogError(reason instanceof Error ? reason.message : t("Could not revoke connection"));
    } finally {
      setPending(null);
    }
  }

  function beginSource(kind: SourceKind) {
    setSourceKind(kind);
    setSourceError(null);
    setName(kind === "treg" ? "Treg" : "");
    setUrl(kind === "treg" ? "https://treg.to/mcp/" : "");
    setCredential("");
    setRequiresAuth(kind === "treg");
  }

  async function addSource() {
    if (!sourceKind) return;
    setPending("source");
    setSourceError(null);
    try {
      await rpc("capabilities/install", {
        kind: sourceKind === "api" ? "api" : "mcp",
        name: name.trim() || (sourceKind === "treg" ? "Treg" : t("Custom connector")),
        source: url.trim(),
        credential: credential.trim() || undefined,
        config:
          sourceKind === "treg"
            ? { preset: "treg", auth: { type: "bearer" } }
            : sourceKind === "api"
              ? { openApi: true, auth: { type: requiresAuth ? "bearer" : "none" } }
              : { preset: "custom", auth: { type: requiresAuth ? "bearer" : "none" } },
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

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
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

        {catalogError ? <Text style={styles.error}>{catalogError}</Text> : null}

        {!catalogReady ? <ActivityIndicator color={native.fillPressed} /> : null}

        {catalogReady && catalog.length === 0 ? (
          <Text style={styles.secondary}>{t(EMPTY_PLUGIN_CATALOG_MESSAGE)}</Text>
        ) : null}

        {catalogReady && catalog.length > 0 ? (
          <View style={catalogColumns === 2 ? styles.catalogGrid : styles.catalogStack}>
            {showFeatured
              ? featuredTiles.map((tile) => {
                  const item = tile.item;
                  const key = item ? `${item.connectorId}:${item.slug}` : tile.id;
                  const disabled = tile.missing || !item;
                  const connected = item?.connected ?? false;
                  return (
                    <View
                      key={key}
                      style={[
                        styles.row,
                        catalogColumns === 2 ? styles.catalogCell : null,
                        disabled ? { opacity: 0.7 } : null,
                      ]}
                    >
                      <ConnectorIcon name={tile.label} logo={item?.logo} />
                      <View style={styles.grow}>
                        <Text numberOfLines={1} style={styles.title}>
                          {tile.label}
                        </Text>
                        {disabled ? (
                          <Text style={styles.secondary}>{t("Not in the plugin catalog")}</Text>
                        ) : null}
                      </View>
                      {disabled || !item ? null : (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={
                            connected
                              ? t("Remove {name}", { name: tile.label })
                              : t("Add {name}", { name: tile.label })
                          }
                          disabled={pending === key}
                          onPress={() => void (connected ? revoke(item) : connect(item))}
                        >
                          <Text style={styles.link}>
                            {pending === key ? t("Working…") : connected ? t("Remove") : t("Add")}
                          </Text>
                        </Pressable>
                      )}
                    </View>
                  );
                })
              : null}
            {renderedApps.map((item) => {
              const key = `${item.connectorId}:${item.slug}`;
              return (
                <View
                  key={key}
                  style={[styles.row, catalogColumns === 2 ? styles.catalogCell : null]}
                >
                  <ConnectorIcon name={item.name} logo={item.logo} />
                  <View style={styles.grow}>
                    <Text numberOfLines={1} style={styles.title}>
                      {item.name}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      item.connected
                        ? t("Remove {name}", { name: item.name })
                        : t("Add {name}", { name: item.name })
                    }
                    disabled={pending === key}
                    onPress={() => void (item.connected ? revoke(item) : connect(item))}
                  >
                    <Text style={styles.link}>
                      {pending === key ? t("Working…") : item.connected ? t("Remove") : t("Add")}
                    </Text>
                  </Pressable>
                </View>
              );
            })}
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
            <View style={styles.actions}>
              {(["mcp", "api", "treg"] as const).map((kind) => (
                <Pressable
                  key={kind}
                  accessibilityRole="button"
                  onPress={() => beginSource(kind)}
                  style={styles.smallButton}
                >
                  <Text style={styles.buttonLabel}>
                    {kind === "treg"
                      ? t("Add Treg")
                      : kind === "mcp"
                        ? t("Add MCP server")
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
                    : sourceKind === "mcp"
                      ? t("Remote MCP server")
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
                        : t("https://example.com/openapi.json")
                    }
                    placeholderTextColor={native.tertiaryLabel}
                    style={styles.input}
                  />
                ) : null}
                {sourceKind !== "treg" ? (
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
                {sourceKind === "treg" || requiresAuth ? (
                  <TextInput
                    value={credential}
                    onChangeText={setCredential}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder={sourceKind === "treg" ? t("Treg token") : t("Bearer token")}
                    placeholderTextColor={native.tertiaryLabel}
                    style={styles.input}
                  />
                ) : null}
                <View style={styles.actions}>
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
      </ScrollView>
    </SafeAreaView>
  );
}

function createIntegrationsStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 14 },
    section: { color: native.secondaryLabel, fontSize: 14, fontWeight: "600", marginTop: 10 },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    smallButton: {
      minHeight: 42,
      paddingHorizontal: 14,
      borderRadius: 12,
      backgroundColor: native.fill,
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
    link: { color: native.label, fontSize: 14, fontWeight: "600" },
    remove: { color: tokens.destructive, fontSize: 14, fontWeight: "600" },
    error: { color: tokens.destructive, fontSize: 14 },
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
