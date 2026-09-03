import type { ModelOAuthBegin } from "@rakazo/contracts";
import {
  OPENAI_COMPATIBLE_BASE_URL_HINT,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleConnectReady,
} from "@rakazo/contracts";
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
import { useI18n } from "../lib/i18n";
import {
  cancelModelOAuthAttempt,
  finishModelOAuthAttempt,
  waitForModelOAuth,
} from "../lib/model-auth";
import { native, useThemedStyles } from "../lib/native";

type ModelSelection = {
  provider?: string;
  modelId?: string;
};

export default function Models() {
  const styles = useThemedStyles(createModelsStyles);
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<MobileModel[]>([]);
  const [credentials, setCredentials] = useState<MobileModelCredential[]>([]);
  const [me, setMe] = useState<MobileMe | null>(null);
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [showEndpointHelp, setShowEndpointHelp] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [probeModels, setProbeModels] = useState<string[]>([]);
  const [probedBaseUrl, setProbedBaseUrl] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [oauth, setOauth] = useState<ModelOAuthBegin | null>(null);
  const [pasteCode, setPasteCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"connect" | "default" | null>(null);
  const [oauthPending, setOauthPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const oauthAbortRef = useRef<AbortController | null>(null);
  const oauthLoginIdRef = useRef<string | null>(null);
  const oauthCodeSubmittingRef = useRef(false);
  const probeRequestIdRef = useRef(0);

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
    const nextCredential = nextCredentials.find((entry) => entry.provider === nextProvider);
    const nextModel =
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? preferred.modelId?.trim() ||
          nextCredential?.modelId ||
          (nextMe.defaultProvider === OPENAI_COMPATIBLE_PROVIDER_ID ? nextMe.defaultModel : "") ||
          ""
        : (nextCatalog.find(
            (entry) => entry.provider === nextProvider && entry.id === preferred.modelId,
          )?.id ??
          nextCatalog.find(
            (entry) => entry.provider === nextProvider && entry.id === nextMe.defaultModel,
          )?.id ??
          nextCatalog.find((entry) => entry.provider === nextProvider)?.id ??
          "");
    setMe(nextMe);
    setCatalog(nextCatalog);
    setCredentials(nextCredentials);
    probeRequestIdRef.current += 1;
    setProbeModels([]);
    setProbedBaseUrl(null);
    setProbing(false);
    setProvider(nextProvider);
    setModelId(nextModel);
    if (nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID) {
      setBaseUrl(nextCredential?.baseUrl ?? "");
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load()
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : t("Could not load model settings")),
        )
        .finally(() => setLoading(false));
      return () => {
        probeRequestIdRef.current += 1;
        cancelOAuth();
      };
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
  const isOpenAiCompatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const credential = credentials.find((entry) => entry.provider === provider);
  const currentEntry = catalog.find(
    (entry) => entry.provider === me?.defaultProvider && entry.id === me?.defaultModel,
  );
  const isActive =
    me?.defaultProvider === selected?.provider &&
    me?.defaultModel === (isOpenAiCompatible ? modelId.trim() : selected?.id);
  const acceptsKey = selected?.auth !== "oauth";
  const subscriptionSignIn = selected?.signIn !== undefined;
  const busy = pending !== null || oauthPending;
  const effectiveBaseUrl = baseUrl.trim();
  const openAiCompatibleReady = openAiCompatibleConnectReady({
    baseUrl: effectiveBaseUrl,
    modelId,
    probedBaseUrl,
    storedBaseUrl: credential?.baseUrl,
  });

  function resetOpenAiCompatibleProbe() {
    probeRequestIdRef.current += 1;
    setProbeModels([]);
    setProbedBaseUrl(null);
    setProbing(false);
  }

  function updateBaseUrl(nextBaseUrl: string) {
    setBaseUrl(nextBaseUrl);
    resetOpenAiCompatibleProbe();
    setError(null);
    setNotice(null);
  }

  function updateApiKey(nextApiKey: string) {
    setApiKey(nextApiKey);
    resetOpenAiCompatibleProbe();
  }

  function chooseProvider(nextProvider: string) {
    cancelOAuth();
    setProvider(nextProvider);
    setModelId(
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? (credentials.find((entry) => entry.provider === nextProvider)?.modelId ?? "")
        : (catalog.find((entry) => entry.provider === nextProvider)?.id ?? ""),
    );
    setBaseUrl(
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? (credentials.find((entry) => entry.provider === nextProvider)?.baseUrl ?? "")
        : "",
    );
    setApiKey("");
    resetOpenAiCompatibleProbe();
    setError(null);
    setNotice(null);
  }

  async function probeServerModels() {
    const trimmedBaseUrl = effectiveBaseUrl;
    if (!trimmedBaseUrl) return;
    resetOpenAiCompatibleProbe();
    const requestId = probeRequestIdRef.current;
    setProbing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await rpc<{ models: string[] }>("models/probeOpenAiCompatible", {
        baseUrl: trimmedBaseUrl,
        apiKey: apiKey.trim() || undefined,
      });
      if (requestId !== probeRequestIdRef.current) return;
      setProbeModels(result.models);
      setProbedBaseUrl(trimmedBaseUrl);
      setModelId((current) => current.trim() || result.models[0] || "");
      setNotice(
        result.models.length === 0
          ? t("Server found. Enter a model name.")
          : result.models.length === 1
            ? t("Found {count} model.", { count: 1 })
            : t("Found {count} models.", { count: result.models.length }),
      );
    } catch (err) {
      if (requestId !== probeRequestIdRef.current) return;
      setError(err instanceof Error ? err.message : t("Could not reach this model server"));
    } finally {
      if (requestId === probeRequestIdRef.current) setProbing(false);
    }
  }

  async function setModelDefault() {
    if (!selected || !credential) return;
    const activeModelId = isOpenAiCompatible ? modelId.trim() : selected.id;
    if (isOpenAiCompatible && !activeModelId) return;
    setError(null);
    setNotice(null);
    setPending("default");
    try {
      await rpc("models/setDefault", { provider: selected.provider, modelId: activeModelId });
      await load({ provider, modelId: activeModelId });
      setNotice(
        isOpenAiCompatible
          ? t("Model updated.")
          : t("Now using {label}.", { label: selected.label }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not change the default model"));
    } finally {
      setPending(null);
    }
  }

  async function connectKey() {
    if (!selected) return;
    if (isOpenAiCompatible) {
      if (!effectiveBaseUrl || !modelId.trim()) return;
    } else if (!apiKey.trim()) {
      return;
    }
    setError(null);
    setNotice(null);
    setPending("connect");
    try {
      await rpc(
        "models/connect",
        isOpenAiCompatible
          ? {
              provider: selected.provider,
              baseUrl: effectiveBaseUrl,
              modelId: modelId.trim(),
              apiKey: apiKey.trim() || undefined,
              label: selected.providerName ?? selected.provider,
            }
          : {
              provider: selected.provider,
              apiKey: apiKey.trim(),
              modelId: selected.id,
              label: selected.providerName ?? selected.provider,
            },
      );
      setApiKey("");
      await load({ provider, modelId });
      setNotice(
        isOpenAiCompatible
          ? t("Saved.")
          : t("Connected and using {label}.", { label: selected.label }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not connect this provider"));
    } finally {
      setPending(null);
    }
  }

  async function finishSubscriptionSignIn(loginId: string, controller: AbortController) {
    await waitForModelOAuth(loginId, controller.signal);
    if (controller.signal.aborted) return;
    await rpc("models/finishOAuth", { loginId }, { signal: controller.signal });
    if (controller.signal.aborted) return;
    oauthLoginIdRef.current = null;
    setOauth(null);
    await load({ provider, modelId });
    if (controller.signal.aborted) return;
    setNotice(t("Connected and using {label}.", { label: selected?.label ?? t("this model") }));
  }

  async function startSubscriptionSignIn() {
    if (!selected) return;
    setError(null);
    setNotice(null);
    setOauthPending(true);
    const controller = new AbortController();
    oauthAbortRef.current = controller;
    let waitingForCode = false;
    try {
      const started = await rpc<ModelOAuthBegin>(
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
      setPasteCode("");
      setOauth(started);
      await Linking.openURL(started.verificationUri);
      waitingForCode = started.mode === "auth-url";
      if (!waitingForCode) await finishSubscriptionSignIn(started.loginId, controller);
    } catch (err) {
      if (controller.signal.aborted) return;
      const loginId = oauthLoginIdRef.current;
      oauthLoginIdRef.current = null;
      if (loginId) void rpc("models/cancelOAuth", { loginId }).catch(() => undefined);
      setError(err instanceof Error ? err.message : t("Could not start sign-in"));
      setOauth(null);
    } finally {
      if (!waitingForCode) {
        finishModelOAuthAttempt(oauthAbortRef, controller, () => setOauthPending(false));
      }
    }
  }

  async function submitOAuthCode() {
    if (oauth?.mode !== "auth-url" || oauthCodeSubmittingRef.current) return;
    const controller = oauthAbortRef.current;
    const code = pasteCode.trim();
    if (!controller || !code) return;
    oauthCodeSubmittingRef.current = true;
    setPasteCode("");
    setError(null);
    let submitted = false;
    let retryable = false;
    try {
      await rpc(
        "models/submitOAuthCode",
        { loginId: oauth.loginId, code },
        {
          signal: controller.signal,
        },
      );
      submitted = true;
      await finishSubscriptionSignIn(oauth.loginId, controller);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (submitted) {
        oauthLoginIdRef.current = null;
        setOauth(null);
        void rpc("models/cancelOAuth", { loginId: oauth.loginId }).catch(() => undefined);
      } else {
        retryable = true;
        setPasteCode(code);
      }
      setError(err instanceof Error ? err.message : t("Could not finish sign-in"));
    } finally {
      oauthCodeSubmittingRef.current = false;
      if (!retryable) {
        finishModelOAuthAttempt(oauthAbortRef, controller, () => setOauthPending(false));
      }
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
          <Text style={styles.eyebrow}>{t("Active model")}</Text>
          <Text style={styles.activeModel}>
            {currentEntry?.label ?? me?.defaultModel ?? t("Deployment default")}
          </Text>
          <Text style={styles.secondary}>
            {currentEntry?.providerName ?? me?.defaultProvider ?? t("Configured by deployment")}
          </Text>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}

        <Text style={styles.sectionTitle}>{t("Providers")}</Text>
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
                    {t(group.entries.length === 1 ? "{count} model" : "{count} models", {
                      count: group.entries.length,
                    })}
                  </Text>
                </View>
                {connected ? <Text style={styles.connected}>{t("Connected")}</Text> : null}
              </Pressable>
            );
          })}
        </View>

        {selected ? (
          <>
            {!isOpenAiCompatible ? <Text style={styles.sectionTitle}>{t("Model")}</Text> : null}
            {isOpenAiCompatible ? (
              <>
                <Text style={styles.sectionTitle}>{t("Server URL")}</Text>
                <TextInput
                  accessibilityLabel={t("OpenAI-compatible server URL")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  onChangeText={updateBaseUrl}
                  placeholder={t("http://127.0.0.1:8000/v1")}
                  placeholderTextColor={native.tertiaryLabel}
                  style={styles.keyInput}
                  value={baseUrl}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showEndpointHelp }}
                  onPress={() => setShowEndpointHelp((visible) => !visible)}
                >
                  <Text style={styles.helpLabel}>{t("Setup help")}</Text>
                </Pressable>
                {showEndpointHelp ? (
                  <Text style={styles.hint}>{t(OPENAI_COMPATIBLE_BASE_URL_HINT)}</Text>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  disabled={busy || probing || !effectiveBaseUrl}
                  onPress={() => void probeServerModels()}
                  style={({ pressed }) => [
                    styles.outlineButton,
                    (busy || probing || !effectiveBaseUrl) && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.outlineLabel}>
                    {probing ? t("Finding…") : t("Find models")}
                  </Text>
                </Pressable>
                <Text style={[styles.sectionTitle, { marginTop: 12 }]}>{t("Model")}</Text>
                {probeModels.length && probeModels.includes(modelId) ? (
                  <View style={styles.card}>
                    {probeModels.map((entry) => (
                      <Pressable
                        key={entry}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: entry === modelId }}
                        disabled={probing}
                        onPress={() => setModelId(entry)}
                        style={({ pressed }) => [
                          styles.modelRow,
                          entry === modelId && styles.selectedRow,
                          probing && styles.disabled,
                          pressed && styles.pressed,
                        ]}
                      >
                        <View style={styles.radio}>
                          {entry === modelId ? <View style={styles.radioDot} /> : null}
                        </View>
                        <Text style={styles.modelLabel}>{entry}</Text>
                      </Pressable>
                    ))}
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityState={{ selected: false }}
                      disabled={probing}
                      onPress={() => setModelId("")}
                      style={({ pressed }) => [
                        styles.modelRow,
                        probing && styles.disabled,
                        pressed && styles.pressed,
                      ]}
                    >
                      <View style={styles.radio} />
                      <Text style={styles.modelLabel}>{t("Other model…")}</Text>
                    </Pressable>
                  </View>
                ) : (
                  <>
                    <TextInput
                      accessibilityLabel={t("Model id")}
                      autoCapitalize="none"
                      autoCorrect={false}
                      editable={!busy && !probing}
                      onChangeText={setModelId}
                      placeholder={t("exact-model-id")}
                      placeholderTextColor={native.tertiaryLabel}
                      style={styles.keyInput}
                      value={modelId}
                    />
                    {probeModels.length ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setModelId(probeModels[0] ?? "")}
                      >
                        <Text style={styles.helpLabel}>{t("Use a found model")}</Text>
                      </Pressable>
                    ) : null}
                  </>
                )}
              </>
            ) : (
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
            )}
            {!isOpenAiCompatible && selected.billing ? (
              <Text style={styles.billing}>{selected.billing}</Text>
            ) : null}

            {!isOpenAiCompatible ? (
              <View style={styles.credentialCard}>
                <Text style={styles.eyebrow}>{t("Personal credential")}</Text>
                <Text style={styles.credentialTitle}>
                  {credential
                    ? t("Connected · {label}", { label: credential.label })
                    : t("Not connected")}
                </Text>
                <Text style={styles.secondary}>
                  {credential
                    ? t(
                        "Your key or subscription token is stored securely and is never shown here.",
                      )
                    : t("Connect this provider to use it as your personal model.")}
                </Text>
              </View>
            ) : null}

            {subscriptionSignIn ? (
              oauth ? (
                <View style={styles.oauthCard}>
                  {oauth.mode === "auth-url" ? (
                    <>
                      <Text style={styles.secondary}>
                        {t("Finish signing in in your browser:")}
                      </Text>
                      <Pressable onPress={() => void Linking.openURL(oauth.verificationUri)}>
                        <Text style={styles.link}>{oauth.verificationUri}</Text>
                      </Pressable>
                      <Text style={styles.secondary}>
                        {t("The final page may not load. Paste its URL or code here.")}
                      </Text>
                      <TextInput
                        accessibilityLabel={t("Authorization code")}
                        value={pasteCode}
                        onChangeText={setPasteCode}
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder={t("http://localhost:53692/callback?code=…")}
                        placeholderTextColor={native.secondaryLabel}
                        style={styles.keyInput}
                      />
                      <Pressable
                        accessibilityRole="button"
                        disabled={!pasteCode.trim()}
                        onPress={() => void submitOAuthCode()}
                        style={({ pressed }) => [
                          styles.outlineButton,
                          pressed && styles.pressed,
                          !pasteCode.trim() && styles.disabled,
                        ]}
                      >
                        <Text style={styles.outlineLabel}>{t("Submit")}</Text>
                      </Pressable>
                      <Text style={styles.secondary}>{t("Waiting for sign-in…")}</Text>
                    </>
                  ) : (
                    <>
                      <Text style={styles.secondary}>{t("Enter this code in your browser:")}</Text>
                      <Pressable onPress={() => void Linking.openURL(oauth.verificationUri)}>
                        <Text style={styles.link}>{oauth.verificationUri}</Text>
                      </Pressable>
                      <Text style={styles.code}>{oauth.userCode}</Text>
                      <Text style={styles.secondary}>{t("Waiting for sign-in…")}</Text>
                    </>
                  )}
                </View>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void startSubscriptionSignIn()}
                  style={({ pressed }) => [
                    styles.outlineButton,
                    pressed && styles.pressed,
                    busy && styles.disabled,
                  ]}
                >
                  <Text style={styles.outlineLabel}>
                    {oauthPending ? t("Starting…") : (selected.oauthLabel ?? t("Sign in"))}
                  </Text>
                </Pressable>
              )
            ) : null}

            {acceptsKey ? (
              <View style={styles.keySection}>
                {isOpenAiCompatible ? (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ expanded: showApiKey }}
                      onPress={() => setShowApiKey((visible) => !visible)}
                    >
                      <Text style={styles.helpLabel}>{t("API key")}</Text>
                    </Pressable>
                    {showApiKey ? (
                      <TextInput
                        accessibilityLabel={t("API key")}
                        autoCapitalize="none"
                        autoCorrect={false}
                        autoComplete="off"
                        editable={!busy}
                        importantForAutofill="no"
                        onChangeText={updateApiKey}
                        placeholder={t("Optional")}
                        placeholderTextColor={native.tertiaryLabel}
                        secureTextEntry
                        style={styles.keyInput}
                        textContentType="none"
                        value={apiKey}
                      />
                    ) : null}
                  </>
                ) : (
                  <>
                    <Text style={styles.sectionTitle}>
                      {credential
                        ? t("Replace API key")
                        : subscriptionSignIn
                          ? t("Or connect an API key")
                          : t("API key")}
                    </Text>
                    <TextInput
                      accessibilityLabel={t("API key")}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="off"
                      editable={!busy}
                      importantForAutofill="no"
                      onChangeText={updateApiKey}
                      placeholder={t("sk-…")}
                      placeholderTextColor={native.tertiaryLabel}
                      secureTextEntry
                      style={styles.keyInput}
                      textContentType="none"
                      value={apiKey}
                    />
                  </>
                )}
                <Pressable
                  accessibilityRole="button"
                  disabled={
                    busy || (isOpenAiCompatible ? !openAiCompatibleReady : apiKey.trim().length < 8)
                  }
                  onPress={() => void connectKey()}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    (busy ||
                      (isOpenAiCompatible ? !openAiCompatibleReady : apiKey.trim().length < 8)) &&
                      styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.primaryLabel}>
                    {pending === "connect"
                      ? t("Saving…")
                      : isOpenAiCompatible
                        ? t("Save")
                        : credential
                          ? t("Replace API key")
                          : t("Connect API key")}
                  </Text>
                </Pressable>
              </View>
            ) : null}

            {selected.auth === "oauth" && !subscriptionSignIn ? (
              <Text style={styles.secondary}>
                {t(
                  "This subscription sign-in is not available in Rakazo yet. Use a deployment credential or choose another provider.",
                )}
              </Text>
            ) : null}

            {credential && !isActive ? (
              <Pressable
                accessibilityRole="button"
                disabled={busy || (isOpenAiCompatible && !modelId.trim())}
                onPress={() => void setModelDefault()}
                style={({ pressed }) => [
                  styles.primaryButton,
                  busy && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.primaryLabel}>
                  {pending === "default" ? t("Switching…") : t("Use this model")}
                </Text>
              </Pressable>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createModelsStyles() {
  return StyleSheet.create({
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
    hint: {
      color: native.secondaryLabel,
      fontSize: 13,
      lineHeight: 19,
      marginTop: 4,
    },
    helpLabel: {
      color: native.secondaryLabel,
      fontSize: 13,
      marginTop: 8,
      textDecorationLine: "underline",
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
}
