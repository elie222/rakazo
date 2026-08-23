import type { CapabilityInstall, Connection, ConnectionCatalogItem } from "@rakazo/contracts";
import { abortableDelay } from "@rakazo/core";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { rpc } from "../lib/api";
import { native } from "../lib/native";

type SourceKind = "treg" | "mcp" | "api";

export default function Integrations() {
  const [catalog, setCatalog] = useState<ConnectionCatalogItem[]>([]);
  const [sources, setSources] = useState<CapabilityInstall[]>([]);
  const [sourceKind, setSourceKind] = useState<SourceKind | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [requiresAuth, setRequiresAuth] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connectionAttempt = useRef<AbortController | null>(null);

  async function refresh() {
    const [nextCatalog, installs] = await Promise.all([
      rpc<ConnectionCatalogItem[]>("connections/catalog"),
      rpc<CapabilityInstall[]>("capabilities/list"),
    ]);
    setCatalog(nextCatalog);
    setSources(installs.filter((item) => item.kind === "mcp" || item.kind === "api"));
  }

  useEffect(() => {
    void refresh().catch((reason) =>
      setError(reason instanceof Error ? reason.message : "Could not load integrations"),
    );
    return () => connectionAttempt.current?.abort();
  }, []);

  async function connect(item: ConnectionCatalogItem) {
    connectionAttempt.current?.abort();
    const controller = new AbortController();
    connectionAttempt.current = controller;
    const key = `${item.connectorId}:${item.slug}`;
    setPending(key);
    setError(null);
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
          await refresh();
          return;
        }
        await abortableDelay(2_000, controller.signal);
      }
      if (controller.signal.aborted) return;
      Alert.alert(
        "Connection pending",
        "Finish connecting in the browser, then refresh this page.",
      );
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "Could not connect");
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
    setError(null);
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
      if (!row) throw new Error(`No connection record found for ${item.name}.`);
      await rpc("connections/revoke", { connectionId: row.id });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not revoke connection");
    } finally {
      setPending(null);
    }
  }

  function beginSource(kind: SourceKind) {
    setSourceKind(kind);
    setName(kind === "treg" ? "Treg" : "");
    setUrl(kind === "treg" ? "https://treg.to/mcp/" : "");
    setCredential("");
    setRequiresAuth(kind === "treg");
  }

  async function addSource() {
    if (!sourceKind) return;
    setPending("source");
    setError(null);
    try {
      await rpc("capabilities/install", {
        kind: sourceKind === "api" ? "api" : "mcp",
        name: name.trim() || (sourceKind === "treg" ? "Treg" : "Custom connector"),
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
      setError(reason instanceof Error ? reason.message : "Could not add source");
    } finally {
      setPending(null);
    }
  }

  async function removeSource(source: CapabilityInstall) {
    setPending(source.id);
    try {
      await rpc("capabilities/remove", { id: source.id });
      setSources((current) => current.filter((item) => item.id !== source.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not remove source");
    } finally {
      setPending(null);
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.explanation}>
          Connect managed apps or install a remote tool source. Credentials are encrypted and never
          shown to bots.
        </Text>

        <View style={styles.actions}>
          {(["treg", "mcp", "api"] as const).map((kind) => (
            <Pressable
              key={kind}
              accessibilityRole="button"
              onPress={() => beginSource(kind)}
              style={styles.smallButton}
            >
              <Text style={styles.buttonLabel}>
                {kind === "treg" ? "Add Treg" : kind === "mcp" ? "Add MCP" : "Add OpenAPI"}
              </Text>
            </Pressable>
          ))}
        </View>

        {sourceKind ? (
          <View style={styles.card}>
            <Text style={styles.title}>
              {sourceKind === "treg"
                ? "Connect Treg"
                : sourceKind === "mcp"
                  ? "Remote MCP server"
                  : "OpenAPI JSON"}
            </Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Display name"
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
                    ? "https://example.com/mcp"
                    : "https://example.com/openapi.json"
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
                  {requiresAuth ? "Bearer authentication" : "No authentication"}
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
                placeholder={sourceKind === "treg" ? "Treg token" : "Bearer token"}
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
                  <Text style={styles.buttonLabel}>Verify and add</Text>
                )}
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => setSourceKind(null)}
                style={styles.smallButton}
              >
                <Text style={styles.buttonLabel}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Text style={styles.section}>Tool sources</Text>
        {sources.length === 0 ? (
          <Text style={styles.secondary}>No custom sources installed.</Text>
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
              <Text style={styles.remove}>{pending === source.id ? "Removing…" : "Remove"}</Text>
            </Pressable>
          </View>
        ))}

        <Text style={styles.section}>Apps</Text>
        {catalog.length === 0 ? (
          <Text style={styles.secondary}>No managed app catalog configured.</Text>
        ) : null}
        {catalog.map((item) => {
          const key = `${item.connectorId}:${item.slug}`;
          return (
            <View key={key} style={styles.row}>
              <View style={styles.grow}>
                <Text style={styles.title}>{item.name}</Text>
                <Text style={styles.secondary}>
                  {item.connectorId} · {item.slug}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                disabled={pending === key}
                onPress={() => void (item.connected ? revoke(item) : connect(item))}
              >
                <Text style={styles.link}>
                  {pending === key ? "Working…" : item.connected ? "Revoke" : "Connect"}
                </Text>
              </Pressable>
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: native.page },
  content: { padding: 20, gap: 14 },
  explanation: { color: native.secondaryLabel, fontSize: 14, lineHeight: 20 },
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
  row: {
    minHeight: 64,
    padding: 14,
    borderRadius: 14,
    backgroundColor: native.fill,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  grow: { flex: 1, gap: 3 },
  title: { color: native.label, fontSize: 16, fontWeight: "600" },
  secondary: { color: native.secondaryLabel, fontSize: 13 },
  link: { color: native.label, fontSize: 14, fontWeight: "600" },
  remove: { color: "#E96B6B", fontSize: 14, fontWeight: "600" },
  error: { color: "#E96B6B", fontSize: 14 },
});
