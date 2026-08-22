import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { type MobileMe, type MobileModel, type MobileModelCredential, rpc } from "../lib/api";
import {
  cancelModelOAuthAttempt,
  finishModelOAuthAttempt,
  waitForModelOAuth,
} from "../lib/model-auth";
import { native } from "../lib/native";

type OAuthNotice = {
  verificationUri: string;
  userCode: string;
};

type ModelSelection = {
  provider?: string;
  modelId?: string;
};

function formatKeyCoverage(models: string[] | undefined) {
  if (!models?.length) return "Not probed yet. Refresh coverage after you add keys.";
  if (models.length <= 8) return models.join(", ");
  return `${models.slice(0, 8).join(", ")} +${models.length - 8} more`;
}

export default function Models() {
  const [catalog, setCatalog] = useState<MobileModel[]>([]);
  const [credentials, setCredentials] = useState<MobileModelCredential[]>([]);
  const [me, setMe] = useState<MobileMe | null>(null);
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyLabel, setKeyLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [endpointLabel, setEndpointLabel] = useState("Custom endpoint");
  const [probedModels, setProbedModels] = useState<string[]>([]);
  const [oauth, setOauth] = useState<OAuthNotice | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<
    "connect" | "default" | "probe" | "key" | "refresh" | null
  >(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [oauthPending, setOauthPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const oauthAbortRef = useRef<AbortController | null>(null);
  const oauthLoginIdRef = useRef<string | null>(null);

  const cancelOAuth = useCallback(() => {
    const loginId = oauthLoginIdRef.current;
    oauthLoginIdRef.current = null;
    cancelModelOAuthAttempt(oauthAbortRef, () => {
      setOauth(null);
      setOauthPending(false);
    });
    if (loginId) void rpc("models/cancelOAuth", { loginId }).catch(() => undefined);
  }, []);

  const load = useCallback(async (preferred: ModelSelection = {}) => {
    setError(null);
    const [nextMe, nextCatalog, nextCredentials] = await Promise.all([
      rpc<MobileMe>("me"),
      rpc<MobileModel[]>("models/list"),
      rpc<MobileModelCredential[]>("models/credentials"),
    ]);
    const nextProvider =
      (preferred.provider && nextCatalog.some((entry) => entry.provider === preferred.provider)
        ? preferred.provider
        : nextMe.defaultProvider) ??
      nextCatalog[0]?.provider ??
      "";
    const nextModel =
      nextCatalog.find((entry) => entry.provider === nextProvider && entry.id === preferred.modelId)
        ?.id ??
      nextCatalog.find(
        (entry) => entry.provider === nextProvider && entry.id === nextMe.defaultModel,
      )?.id ??
      nextCatalog.find((entry) => entry.provider === nextProvider)?.id ??
      "";
    setMe(nextMe);
    setCatalog(nextCatalog);
    setCredentials(nextCredentials);
    setProvider(nextProvider);
    setModelId(nextModel);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load()
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : "Could not load model settings"),
        )
        .finally(() => setLoading(false));
      return cancelOAuth;
    }, [cancelOAuth, load]),
  );

  const groups = useMemo(() => {
    const grouped = new Map<string, MobileModel[]>();
    for (const entry of catalog) {
      const entries = grouped.get(entry.provider) ?? [];
      entries.push(entry);
      grouped.set(entry.provider, entries);
    }
    return [...grouped].map(([id, entries]) => ({
      id,
      name: entries[0]?.providerName ?? id,
      entries,
    }));
  }, [catalog]);
  const modelsForProvider = catalog.filter((entry) => entry.provider === provider);
  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  const credential = credentials.find((entry) => entry.provider === provider);
  const currentEntry = catalog.find(
    (entry) => entry.provider === me?.defaultProvider && entry.id === me?.defaultModel,
  );
  const isActive = me?.defaultProvider === selected?.provider && me?.defaultModel === selected?.id;
  const acceptsKey = selected?.auth !== "oauth";
  const deviceSignIn = selected?.signIn === "device-code";
  const busy = pending !== null || oauthPending;

  function chooseProvider(nextProvider: string) {
    cancelOAuth();
    setProvider(nextProvider);
    setModelId(catalog.find((entry) => entry.provider === nextProvider)?.id ?? "");
    setApiKey("");
    setKeyLabel("");
    setBaseUrl(catalog.find((entry) => entry.provider === nextProvider)?.baseUrl ?? "");
    setEndpointLabel(
      catalog.find((entry) => entry.provider === nextProvider)?.providerName ?? "Custom endpoint",
    );
    setProbedModels(
      credentials.find((entry) => entry.provider === nextProvider)?.availableModels ?? [],
    );
    setError(null);
    setNotice(null);
  }

  async function setModelDefault() {
    if (!selected || !credential) return;
    setError(null);
    setNotice(null);
    setPending("default");
    try {
      await rpc("models/setDefault", { provider: selected.provider, modelId: selected.id });
      await load({ provider, modelId });
      setNotice(`Now using ${selected.label}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the default model");
    } finally {
      setPending(null);
    }
  }

  async function connectKey() {
    if (!selected) return;
    if (isCustom) {
      const url = baseUrl.trim() || selected.baseUrl;
      if (!url) {
        setError("Enter a base URL for this endpoint.");
        return;
      }
      setError(null);
      setNotice(null);
      setPending("connect");
      try {
        const connected = await rpc<MobileModelCredential>("models/connect", {
          provider: selected.provider,
          apiKey: credential ? "" : apiKey.trim(),
          modelId: modelId.trim() || selected.id,
          label: endpointLabel.trim() || selected.providerName || "Custom endpoint",
          baseUrl: url,
          availableModels: probedModels.length
            ? probedModels
            : modelId.trim()
              ? [modelId.trim()]
              : undefined,
        });
        setApiKey("");
        await load({ provider: connected.provider, modelId: connected.defaultModel ?? modelId });
        setNotice(`Connected ${connected.label}.`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not connect this endpoint");
      } finally {
        setPending(null);
      }
      return;
    }
    if (!apiKey.trim()) return;
    setError(null);
    setNotice(null);
    setPending("connect");
    try {
      await rpc("models/connect", {
        provider: selected.provider,
        apiKey: apiKey.trim(),
        modelId: selected.id,
        label: selected.providerName ?? selected.provider,
      });
      setApiKey("");
      await load({ provider, modelId });
      setNotice(`Connected and using ${selected.label}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect this provider");
    } finally {
      setPending(null);
    }
  }

  async function probeModels() {
    const url = baseUrl.trim() || selected?.baseUrl;
    if (!url) {
      setError("Enter a base URL to list models.");
      return;
    }
    setError(null);
    setNotice(null);
    setPending("probe");
    try {
      const result = await rpc<{ models: string[] }>("models/probe", {
        baseUrl: url,
        apiKey: apiKey.trim() || undefined,
      });
      setProbedModels(result.models);
      if (!result.models.includes(modelId) && result.models[0]) setModelId(result.models[0]);
      setNotice(`Found ${result.models.length} model${result.models.length === 1 ? "" : "s"}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not list models");
    } finally {
      setPending(null);
    }
  }

  async function addEndpointKey() {
    if (!selected || !apiKey.trim()) return;
    setError(null);
    setNotice(null);
    setPending("key");
    try {
      const updated = await rpc<MobileModelCredential>("models/addKey", {
        provider: selected.provider,
        apiKey: apiKey.trim(),
        label: keyLabel.trim() || undefined,
      });
      setApiKey("");
      setKeyLabel("");
      setProbedModels(updated.availableModels ?? []);
      await load({ provider, modelId });
      setNotice("Saved that key. Rakazo will use it for the models it can access.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add API key");
    } finally {
      setPending(null);
    }
  }

  async function refreshEndpointKeys() {
    if (!selected) return;
    setError(null);
    setNotice(null);
    setPending("refresh");
    try {
      const updated = await rpc<MobileModelCredential>("models/refreshKeys", {
        provider: selected.provider,
      });
      setProbedModels(updated.availableModels ?? []);
      await load({ provider, modelId });
      setNotice("Updated which models each API key can use.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not refresh API keys");
    } finally {
      setPending(null);
    }
  }

  async function activateEndpointKey(keyId: string) {
    if (!selected) return;
    setError(null);
    setNotice(null);
    setPending("key");
    try {
      await rpc("models/setActiveKey", { provider: selected.provider, keyId });
      await load({ provider, modelId });
      setNotice("This key is the fallback when a model is not on any other key.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not switch API key");
    } finally {
      setPending(null);
    }
  }

  async function removeEndpointKey(keyId: string) {
    if (!selected) return;
    setError(null);
    setNotice(null);
    setPending("key");
    try {
      const updated = await rpc<MobileModelCredential>("models/removeKey", {
        provider: selected.provider,
        keyId,
      });
      setProbedModels(updated.availableModels ?? []);
      await load({ provider, modelId });
      setNotice("Removed that API key.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove API key");
    } finally {
      setPending(null);
    }
  }

  async function startDeviceSignIn() {
    if (!selected) return;
    setError(null);
    setNotice(null);
    setOauthPending(true);
    const controller = new AbortController();
    oauthAbortRef.current = controller;
    try {
      const started = await rpc<{
        loginId: string;
        verificationUri: string;
        userCode: string;
      }>(
        "models/beginOAuth",
        {
          provider: selected.provider,
          modelId: selected.id,
          label: selected.providerName ?? selected.provider,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      oauthLoginIdRef.current = started.loginId;
      setOauth({ verificationUri: started.verificationUri, userCode: started.userCode });
      await Linking.openURL(started.verificationUri);
      await waitForModelOAuth(started.loginId, controller.signal);
      if (controller.signal.aborted) return;
      await rpc("models/finishOAuth", { loginId: started.loginId }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      oauthLoginIdRef.current = null;
      setOauth(null);
      await load({ provider, modelId });
      if (controller.signal.aborted) return;
      setNotice(`Connected and using ${selected.label}.`);
    } catch (err) {
      if (controller.signal.aborted) return;
      const loginId = oauthLoginIdRef.current;
      oauthLoginIdRef.current = null;
      if (loginId) void rpc("models/cancelOAuth", { loginId }).catch(() => undefined);
      setError(err instanceof Error ? err.message : "Could not start sign-in");
      setOauth(null);
    } finally {
      finishModelOAuthAttempt(oauthAbortRef, controller, () => setOauthPending(false));
    }
  }

  if (loading && catalog.length === 0) {
    return (
      <SafeAreaView edges={["bottom"]} style={[styles.screen, styles.centered]}>
        <ActivityIndicator color={native.secondaryLabel} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.activeCard}>
          <Text style={styles.eyebrow}>Active model</Text>
          <Text style={styles.activeModel}>
            {currentEntry?.label ?? me?.defaultModel ?? "Deployment default"}
          </Text>
          <Text style={styles.secondary}>
            {currentEntry?.providerName ?? me?.defaultProvider ?? "Configured by deployment"}
          </Text>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}

        <Text style={styles.sectionTitle}>Providers</Text>
        <View style={styles.card}>
          {groups.map((group) => {
            const connected = credentials.some((entry) => entry.provider === group.id);
            return (
              <Pressable
                key={group.id}
                accessibilityRole="button"
                onPress={() => chooseProvider(group.id)}
                style={({ pressed }) => [
                  styles.providerRow,
                  group.id === provider && styles.selectedRow,
                  pressed && styles.pressed,
                ]}
              >
                <View style={styles.providerCopy}>
                  <Text style={styles.providerName}>{group.name}</Text>
                  <Text style={styles.secondary}>
                    {group.entries.length} model{group.entries.length === 1 ? "" : "s"}
                  </Text>
                </View>
                {connected ? <Text style={styles.connected}>Connected</Text> : null}
              </Pressable>
            );
          })}
        </View>

        {selected ? (
          <>
            <Text style={styles.sectionTitle}>Model</Text>
            <View style={styles.card}>
              {modelsForProvider.map((entry) => (
                <Pressable
                  key={`${entry.provider}:${entry.id}`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: entry.id === selected.id }}
                  onPress={() => {
                    cancelOAuth();
                    setModelId(entry.id);
                    setError(null);
                    setNotice(null);
                  }}
                  style={({ pressed }) => [
                    styles.modelRow,
                    entry.id === selected.id && styles.selectedRow,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.radio}>
                    {entry.id === selected.id ? <View style={styles.radioDot} /> : null}
                  </View>
                  <Text style={styles.modelLabel}>{entry.label}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.billing}>{selected.billing}</Text>

            <View style={styles.credentialCard}>
              <Text style={styles.eyebrow}>Personal credential</Text>
              <Text style={styles.credentialTitle}>
                {credential ? `Connected · ${credential.label}` : "Not connected"}
              </Text>
              <Text style={styles.secondary}>
                {credential
                  ? isCustom
                    ? credential.baseUrl || "Custom OpenAI-compatible endpoint."
                    : "Your key or subscription token is stored securely and is never shown here."
                  : isCustom
                    ? "Paste any OpenAI-compatible base URL. Extra API keys live under Advanced — Rakazo matches each key to the models it can run."
                    : "Connect this provider to use it as your personal model."}
              </Text>
            </View>

            {isCustom && credential ? (
              <View style={styles.credentialCard}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setAdvancedOpen((open) => !open)}
                  style={styles.advancedHeader}
                >
                  <Text style={styles.eyebrow}>Advanced</Text>
                  <Text style={styles.secondaryAction}>
                    {advancedOpen
                      ? "Hide"
                      : credential.keys.length
                        ? `${credential.keys.length} API key${credential.keys.length === 1 ? "" : "s"}`
                        : "API keys"}
                  </Text>
                </Pressable>
                {advancedOpen ? (
                  <>
                    <Text style={styles.secondary}>
                      Save every provider key here. Rakazo asks the endpoint which models each key
                      can access, then uses that key automatically.
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy || !credential.keys.length}
                      onPress={() => void refreshEndpointKeys()}
                      style={({ pressed }) => [
                        styles.outlineButton,
                        (busy || !credential.keys.length) && styles.disabled,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text style={styles.outlineLabel}>
                        {pending === "refresh" ? "Refreshing…" : "Refresh model coverage"}
                      </Text>
                    </Pressable>
                    {credential.keys.length ? (
                      credential.keys.map((key) => (
                        <View key={key.id} style={styles.keyCard}>
                          <View style={styles.keyRow}>
                            <Text style={styles.keyName}>{key.label}</Text>
                            {key.isActive ? (
                              <Text style={styles.connected}>Fallback</Text>
                            ) : (
                              <Pressable
                                disabled={busy}
                                onPress={() => void activateEndpointKey(key.id)}
                              >
                                <Text style={styles.secondaryAction}>Fallback</Text>
                              </Pressable>
                            )}
                            {credential.keys.length > 1 ? (
                              <Pressable
                                disabled={busy}
                                onPress={() => void removeEndpointKey(key.id)}
                              >
                                <Text style={styles.error}>Remove</Text>
                              </Pressable>
                            ) : null}
                          </View>
                          <Text style={styles.secondary}>
                            {key.probeError
                              ? key.probeError
                              : formatKeyCoverage(key.availableModels)}
                          </Text>
                        </View>
                      ))
                    ) : (
                      <Text style={styles.secondary}>
                        No keys yet. Local servers can run without one.
                      </Text>
                    )}
                    <TextInput
                      accessibilityLabel="Key label"
                      onChangeText={setKeyLabel}
                      placeholder="Optional"
                      placeholderTextColor={native.tertiaryLabel}
                      style={styles.keyInput}
                      value={keyLabel}
                    />
                    <TextInput
                      accessibilityLabel="Add API key"
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="off"
                      editable={!busy}
                      importantForAutofill="no"
                      onChangeText={setApiKey}
                      placeholder="sk-…"
                      placeholderTextColor={native.tertiaryLabel}
                      secureTextEntry
                      style={styles.keyInput}
                      textContentType="none"
                      value={apiKey}
                    />
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy || !apiKey.trim()}
                      onPress={() => void addEndpointKey()}
                      style={({ pressed }) => [
                        styles.outlineButton,
                        (busy || !apiKey.trim()) && styles.disabled,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text style={styles.outlineLabel}>
                        {pending === "key" ? "Adding…" : "Add API key"}
                      </Text>
                    </Pressable>
                  </>
                ) : null}
              </View>
            ) : null}

            {deviceSignIn ? (
              oauth ? (
                <View style={styles.oauthCard}>
                  <Text style={styles.secondary}>Enter this code in your browser:</Text>
                  <Pressable onPress={() => void Linking.openURL(oauth.verificationUri)}>
                    <Text style={styles.link}>{oauth.verificationUri}</Text>
                  </Pressable>
                  <Text style={styles.code}>{oauth.userCode}</Text>
                  <Text style={styles.secondary}>Waiting for sign-in…</Text>
                </View>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void startDeviceSignIn()}
                  style={({ pressed }) => [
                    styles.outlineButton,
                    pressed && styles.pressed,
                    busy && styles.disabled,
                  ]}
                >
                  <Text style={styles.outlineLabel}>
                    {oauthPending ? "Starting…" : (selected.oauthLabel ?? "Sign in")}
                  </Text>
                </Pressable>
              )
            ) : null}

            {acceptsKey && !(isCustom && credential) ? (
              <View style={styles.keySection}>
                <Text style={styles.sectionTitle}>
                  {credential
                    ? "Replace API key"
                    : deviceSignIn
                      ? "Or connect an API key"
                      : "API key"}
                </Text>
                <TextInput
                  accessibilityLabel="API key"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  editable={!busy}
                  importantForAutofill="no"
                  onChangeText={setApiKey}
                  placeholder="sk-…"
                  placeholderTextColor={native.tertiaryLabel}
                  secureTextEntry
                  style={styles.keyInput}
                  textContentType="none"
                  value={apiKey}
                />
                <Pressable
                  accessibilityRole="button"
                  disabled={busy || apiKey.trim().length < 8}
                  onPress={() => void connectKey()}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    (busy || apiKey.trim().length < 8) && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.primaryLabel}>
                    {pending === "connect"
                      ? "Saving…"
                      : credential
                        ? "Replace API key"
                        : "Connect API key"}
                  </Text>
                </Pressable>
              </View>
            ) : null}

            {selected.auth === "oauth" && !deviceSignIn ? (
              <Text style={styles.secondary}>
                This subscription sign-in is not available in Rakazo yet. Use a deployment
                credential or choose another provider.
              </Text>
            ) : null}

            {isCustom && credential ? (
              <Pressable
                accessibilityRole="button"
                disabled={busy || !(baseUrl.trim() || selected.baseUrl)}
                onPress={() => void connectKey()}
                style={({ pressed }) => [
                  styles.primaryButton,
                  (busy || !(baseUrl.trim() || selected.baseUrl)) && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.primaryLabel}>
                  {pending === "connect" ? "Saving…" : "Save endpoint"}
                </Text>
              </Pressable>
            ) : null}

            {credential ? (
              <Pressable
                accessibilityRole="button"
                disabled={busy || isActive}
                onPress={() => void setModelDefault()}
                style={({ pressed }) => [
                  isActive ? styles.outlineButton : styles.primaryButton,
                  (busy || isActive) && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={isActive ? styles.outlineLabel : styles.primaryLabel}>
                  {isActive
                    ? "Active model"
                    : pending === "default"
                      ? "Switching…"
                      : "Use this model"}
                </Text>
              </Pressable>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: native.page,
  },
  centered: {
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    padding: 20,
    gap: 12,
    paddingBottom: 40,
  },
  activeCard: {
    borderRadius: 16,
    backgroundColor: native.fill,
    padding: 18,
    marginBottom: 8,
  },
  eyebrow: {
    color: native.tertiaryLabel,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  activeModel: {
    color: native.label,
    fontSize: 19,
    fontWeight: "600",
    marginTop: 6,
  },
  secondary: {
    color: native.secondaryLabel,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 4,
  },
  sectionTitle: {
    color: native.secondaryLabel,
    fontSize: 14,
    marginTop: 8,
    marginBottom: 2,
  },
  card: {
    borderRadius: 14,
    backgroundColor: native.fill,
    overflow: "hidden",
  },
  providerRow: {
    minHeight: 62,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: native.fillPressed,
  },
  providerCopy: {
    flex: 1,
  },
  providerName: {
    color: native.label,
    fontSize: 16,
    fontWeight: "600",
  },
  connected: {
    color: "#4ECB71",
    fontSize: 13,
  },
  modelRow: {
    minHeight: 54,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: native.fillPressed,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: native.secondaryLabel,
    alignItems: "center",
    justifyContent: "center",
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: native.label,
  },
  modelLabel: {
    flex: 1,
    color: native.label,
    fontSize: 15,
  },
  selectedRow: {
    backgroundColor: "#222225",
  },
  billing: {
    color: native.secondaryLabel,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 2,
  },
  credentialCard: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: native.fillPressed,
    padding: 16,
    marginTop: 8,
  },
  credentialTitle: {
    color: native.label,
    fontSize: 16,
    marginTop: 6,
  },
  keyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 10,
  },
  advancedHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  keyCard: {
    marginTop: 10,
  },
  keyName: {
    flex: 1,
    color: native.label,
    fontSize: 15,
  },
  secondaryAction: {
    color: native.secondaryLabel,
    fontSize: 13,
  },
  oauthCard: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: native.fillPressed,
    padding: 16,
    marginTop: 8,
  },
  link: {
    color: native.label,
    fontSize: 14,
    textDecorationLine: "underline",
    marginTop: 6,
  },
  code: {
    color: native.label,
    fontFamily: "monospace",
    fontSize: 24,
    letterSpacing: 3,
    marginTop: 10,
    marginBottom: 2,
  },
  keySection: {
    marginTop: 4,
  },
  keyInput: {
    height: 48,
    borderRadius: 12,
    backgroundColor: native.fill,
    color: native.label,
    paddingHorizontal: 14,
    marginTop: 4,
    fontSize: 16,
  },
  primaryButton: {
    minHeight: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: native.label,
    marginTop: 12,
    paddingHorizontal: 16,
  },
  primaryLabel: {
    color: native.page,
    fontSize: 16,
    fontWeight: "700",
  },
  outlineButton: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: native.fillPressed,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 12,
    paddingHorizontal: 16,
  },
  outlineLabel: {
    color: native.label,
    fontSize: 16,
    fontWeight: "600",
  },
  error: {
    color: "#FF6961",
    fontSize: 14,
    marginTop: 4,
  },
  notice: {
    color: "#4ECB71",
    fontSize: 14,
    marginTop: 4,
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.7,
  },
});
