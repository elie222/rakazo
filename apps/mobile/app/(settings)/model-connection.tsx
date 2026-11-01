import type {
  ModelApiProtocol,
  ModelHeaderRow,
  ModelOAuthBegin,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
  cloudflareModelRouting,
  compatibleConnectionName,
  connectionDisplayName,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  isCloudflareModelProvider,
  isOllamaCloudBaseUrl,
  MAX_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_MAX_TOKENS,
  modelHeadersInput,
  OPENAI_COMPATIBLE_BASE_URL_HINT,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  savedCompatibleEndpointMatches,
} from "@rakazo/contracts";
import {
  clampCatalogThinkingLevel,
  compatibleConnectionReady,
  compatibleModelRows,
  compatibleThinkingLevels,
  connectionFormFields,
  connectionFormModelId,
  connectionMaxTokensField,
  createModelProbe,
  initialModelProbeState,
  modelConnectRequest,
  savedCompatibleModelIds,
  toggleEnabledModelId,
} from "@rakazo/core";
import * as Clipboard from "expo-clipboard";
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Keyboard,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { HeaderRowsEditor } from "../../components/header-rows-editor";
import { MenuPickerMenu } from "../../components/menu-picker";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSwitch } from "../../components/native-switch";
import { Checkmark } from "../../components/row-accessories";
import { SettingsRow } from "../../components/settings-group";
import type { MobileMe, MobileModel, MobileModelCredential } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import {
  cancelModelOAuthAttempt,
  finishModelOAuthAttempt,
  waitForModelOAuth,
} from "../../lib/model-auth";
import { modelConnectionRequest } from "../../lib/model-connection-request";
import { native, useThemedStyles } from "../../lib/native";
import { ACCOUNT_SETTINGS, settingsRpc } from "../../lib/settings-target";
import { thinkingLevelLabel } from "../../lib/thinking-level";
import { errorText } from "../../lib/user-error";

type ModelSelection = {
  modelId?: string;
};

type FeedbackAnchor = "probe" | "model" | "connection" | "limits";

/** Connects or manages one provider for the model list that opened it. */
export default function ModelConnection() {
  const styles = useThemedStyles(createModelsStyles);
  const router = useRouter();
  const navigation = useNavigation();
  const { requestId = "" } = useLocalSearchParams<{ requestId?: string }>();
  const [request] = useState(() => modelConnectionRequest(requestId));
  const makeDefault = request?.makeDefault ?? false;
  const target = request?.target ?? ACCOUNT_SETTINGS;
  // A Space's override connects through that Space, where makeDefault and sign-in apply.
  const rpc = useMemo(() => settingsRpc(target), [target]);
  // A new connection is managed by its id once it is saved, so later saves update it.
  const [credentialId, setCredentialId] = useState(request?.credentialId ?? null);
  const credentialIdRef = useRef(credentialId);
  credentialIdRef.current = credentialId;
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<MobileModel[]>([]);
  const [credentials, setCredentials] = useState<MobileModelCredential[]>([]);
  const [me, setMe] = useState<MobileMe | null>(null);
  const provider = request?.provider ?? "";
  // The provider whose optional personal-key form is open.
  const [ownKeyProvider, setOwnKeyProvider] = useState<string | null>(null);
  const [modelId, setModelId] = useState("");
  const [enabledModelIds, setEnabledModelIds] = useState<string[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [gatewayId, setGatewayId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiProtocol, setApiProtocol] = useState<ModelApiProtocol>("chat-completions");
  const [headerRows, setHeaderRows] = useState<ModelHeaderRow[] | null>(null);
  const [reasoning, setReasoning] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | null>(null);
  const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MODEL_MAX_TOKENS));
  const [contextWindow, setContextWindow] = useState(String(DEFAULT_MODEL_CONTEXT_WINDOW));
  const [supportsImages, setSupportsImages] = useState(false);
  const [maxImagesPerPrompt, setMaxImagesPerPrompt] = useState("");
  const [showEndpointHelp, setShowEndpointHelp] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [{ models: probeModels, probing }, setProbe] = useState(initialModelProbeState);
  const [modelProbe] = useState(() => createModelProbe(setProbe));
  const resetOpenAiCompatibleProbe = modelProbe.reset;
  const [oauth, setOauth] = useState<ModelOAuthBegin | null>(null);
  const [pasteCode, setPasteCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"connect" | "disconnect" | null>(null);
  const [oauthPending, setOauthPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const meRef = useRef<MobileMe | null>(null);
  meRef.current = me;
  const [feedbackAnchor, setFeedbackAnchor] = useState<FeedbackAnchor>("connection");
  const oauthAbortRef = useRef<AbortController | null>(null);
  const oauthLoginIdRef = useRef<string | null>(null);
  const oauthCodeSubmittingRef = useRef(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const codeCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function publishFeedback(
    anchor: FeedbackAnchor,
    next: { error?: string | null; notice?: string | null },
  ) {
    const nextError = next.error ?? null;
    setFeedbackAnchor(anchor);
    setError(nextError);
    setSavedNotice(next.notice === t("Saved.") ? next.notice : null);
    const message = nextError ?? next.notice ?? null;
    // VoiceOver keeps focus on the tapped button, so speak the result from here.
    // Saved limits also show their result beside the button that was pressed.
    if (message) AccessibilityInfo.announceForAccessibility(message);
  }

  function clearFeedback() {
    setFeedbackAnchor("connection");
    setError(null);
    setSavedNotice(null);
  }

  const copyOAuthCode = useCallback((code: string) => {
    void Clipboard.setStringAsync(code)
      .then(() => {
        setCodeCopied(true);
        if (codeCopiedTimerRef.current) clearTimeout(codeCopiedTimerRef.current);
        codeCopiedTimerRef.current = setTimeout(() => setCodeCopied(false), 1600);
      })
      .catch(() => undefined);
  }, []);

  const cancelOAuth = useCallback(() => {
    const loginId = oauthLoginIdRef.current;
    oauthLoginIdRef.current = null;
    cancelModelOAuthAttempt(oauthAbortRef, () => {
      setOauth(null);
      setOauthPending(false);
    });
    if (loginId) void rpc("models/cancelOAuth", { loginId }).catch(() => undefined);
  }, [rpc]);

  const cancelInFlightWork = useCallback(() => {
    modelProbe.invalidate();
    cancelOAuth();
    if (codeCopiedTimerRef.current) clearTimeout(codeCopiedTimerRef.current);
  }, [cancelOAuth, modelProbe]);

  useEffect(
    () => () => {
      cancelInFlightWork();
    },
    [cancelInFlightWork],
  );

  const load = useCallback(
    async (preferred: ModelSelection = {}) => {
      if (!request) throw new Error(t("Could not load model settings"));
      setError(null);
      const [nextMe, nextCatalog, nextCredentials] = await Promise.all([
        rpc("me"),
        rpc("models/list"),
        rpc("models/credentials"),
      ]);
      const nextProvider = request.provider;
      const nextCredential = nextCredentials.find((entry) => entry.id === credentialIdRef.current);
      const nextModel = connectionFormModelId({
        catalog: nextCatalog,
        provider: nextProvider,
        credential: nextCredential,
        defaults: nextMe,
        current: preferred.modelId,
      });
      const fields = connectionFormFields({
        catalog: nextCatalog,
        provider: nextProvider,
        modelId: nextModel,
        credential: nextCredential,
        presetBaseUrl: request.baseUrl,
      });
      meRef.current = nextMe;
      setMe(nextMe);
      setCatalog(nextCatalog);
      setCredentials(nextCredentials);
      resetOpenAiCompatibleProbe();
      setModelId(nextModel);
      setHeaderRows(null);
      setEnabledModelIds(fields.enabledModelIds);
      setBaseUrl(fields.baseUrl);
      setApiProtocol(fields.apiProtocol);
      setReasoning(fields.reasoning);
      setThinkingLevel(fields.thinkingLevel);
      setMaxTokens(fields.maxTokens);
      setContextWindow(fields.contextWindow);
      setSupportsImages(fields.supportsImages);
      setMaxImagesPerPrompt(fields.maxImagesPerPrompt);
      setAccountId(fields.accountId);
      setGatewayId(fields.gatewayId);
      return nextMe;
    },
    [request, rpc, t],
  );

  useFocusEffect(
    useCallback(() => {
      void load()
        .catch((err: unknown) =>
          publishFeedback("connection", {
            error: errorText(err, t("Could not load model settings")),
          }),
        )
        .finally(() => setLoading(false));
      return cancelInFlightWork;
    }, [cancelInFlightWork, load]),
  );

  const modelsForProvider = catalog.filter((entry) => entry.provider === provider);
  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  const credential = credentials.find((entry) => entry.id === credentialId);
  const providerName = selected?.providerName ?? selected?.provider ?? "";
  const selectedProviderLabel = credential
    ? connectionDisplayName(credential, providerName)
    : compatibleConnectionName(baseUrl, providerName);
  useLayoutEffect(() => {
    if (selectedProviderLabel) navigation.setOptions({ title: selectedProviderLabel });
  }, [navigation, selectedProviderLabel]);
  const isOpenAiCompatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const isCloudflareGateway = provider === CLOUDFLARE_AI_GATEWAY_PROVIDER_ID;
  const isCloudflare = isCloudflareModelProvider(provider);
  const cloudflareRoutingReady =
    !isCloudflare || cloudflareModelRouting({ provider, accountId, gatewayId }) !== undefined;
  const compatibleRows = compatibleModelRows(
    savedCompatibleModelIds(credential, baseUrl),
    enabledModelIds,
    probeModels,
  );
  const acceptsKey = selected?.auth !== "oauth";
  const subscriptionSignIn = selected?.signIn !== undefined;
  const reasoningEffortValue = thinkingLevel ? thinkingLevelLabel(thinkingLevel, t) : t("Default");
  const busy = pending !== null || oauthPending;
  const effectiveBaseUrl = baseUrl.trim();
  const openAiCompatibleReady = compatibleConnectionReady({
    apiKey,
    baseUrl,
    modelId,
    headerRows,
    credential,
  });
  const limitsDirty = maxTokens !== connectionMaxTokensField(provider, credential?.maxTokens);
  const gatewayDirty =
    accountId.trim() !== (credential?.accountId ?? "") ||
    gatewayId.trim() !== (credential?.gatewayId ?? "");
  const gatewayOnlySave = isCloudflare && Boolean(credential) && !apiKey.trim();
  const protocolChoices: { key: ModelApiProtocol; label: string }[] = [
    { key: "chat-completions", label: t("Chat Completions") },
    { key: "responses", label: t("Responses") },
    { key: "anthropic-messages", label: t("Anthropic Messages") },
  ];
  const apiProtocolLabel = protocolChoices.find((choice) => choice.key === apiProtocol)?.label;

  function updateBaseUrl(nextBaseUrl: string) {
    setBaseUrl(nextBaseUrl);
    setHeaderRows(null);
    // A new endpoint starts with no ticks; the saved endpoint gets its saved list back.
    setEnabledModelIds(savedCompatibleModelIds(credential, nextBaseUrl));
    resetOpenAiCompatibleProbe();
    clearFeedback();
  }

  function updateApiProtocol(nextProtocol: ModelApiProtocol) {
    setApiProtocol(nextProtocol);
    setThinkingLevel(
      clampCatalogThinkingLevel(
        thinkingLevel,
        reasoning ? compatibleThinkingLevels(nextProtocol) : [],
      ) as ThinkingLevel | null,
    );
    resetOpenAiCompatibleProbe();
    clearFeedback();
  }

  function updateApiKey(nextApiKey: string) {
    setApiKey(nextApiKey);
    resetOpenAiCompatibleProbe();
    clearFeedback();
  }

  async function probeServerModels() {
    if (!baseUrl.trim()) return;
    Keyboard.dismiss();
    clearFeedback();
    await modelProbe.probe({
      baseUrl,
      apiKey,
      request: (input) =>
        rpc("models/probeOpenAiCompatible", {
          ...input,
          apiProtocol,
          headers: modelHeadersInput(headerRows),
          credentialId: credential?.id,
        }),
      onSuccess: (models) => {
        const next = modelId.trim() || models[0] || "";
        if (next !== modelId) stageCompatibleModelId(next);
        else setModelId(next);
        publishFeedback("probe", {
          notice:
            models.length === 0
              ? t("Server found. Enter a model name.")
              : models.length === 1
                ? t("Found {count} model.", { count: 1 })
                : t("Found {count} models.", { count: models.length }),
        });
      },
      onError: (err) =>
        publishFeedback("probe", {
          error: errorText(err, t("Could not reach this model server")),
        }),
    });
  }

  async function disconnectCredential() {
    if (!selected || !credential) return;
    cancelOAuth();
    clearFeedback();
    setPending("disconnect");
    try {
      await rpc("models/disconnect", { provider: selected.provider, credentialId: credential.id });
      publishFeedback("connection", {
        notice: t("Disconnected {provider}.", { provider: selectedProviderLabel }),
      });
      router.back();
    } catch (err) {
      publishFeedback("connection", {
        error: errorText(err, t("Could not disconnect this provider")),
      });
    } finally {
      setPending(null);
    }
  }

  function stageCompatibleModelId(nextModelId: string) {
    setModelId(nextModelId);
    setThinkingLevel(
      clampCatalogThinkingLevel(
        credential?.modelId === nextModelId ? credential.thinkingLevel : null,
        reasoning ? compatibleThinkingLevels(apiProtocol) : [],
      ) as ThinkingLevel | null,
    );
  }

  async function connectKey(limitsOnly = false) {
    if (!selected) return;
    const anchor = limitsOnly ? "limits" : "connection";
    const connect = modelConnectRequest({
      form: {
        apiKey,
        modelId,
        enabledModelIds,
        baseUrl,
        apiProtocol,
        headerRows,
        reasoning,
        thinkingLevel,
        maxTokens,
        contextWindow,
        supportsImages,
        maxImagesPerPrompt,
        accountId,
        gatewayId,
      },
      selected,
      credential,
      credentialId: credentialIdRef.current,
      settingsOnly: limitsOnly,
      makeDefault: { makeDefault, scope: target.scope },
    });
    if (connect.status === "incomplete") return;
    // Drop the previous result before the limit check so it cannot sit beside the new one.
    Keyboard.dismiss();
    clearFeedback();
    setFeedbackAnchor(anchor);
    if (connect.status === "invalid") {
      publishFeedback(anchor, {
        error:
          connect.field === "maxTokens"
            ? t("Enter a whole number from 1 to {max} for maximum output tokens.", {
                max: MAX_MODEL_MAX_TOKENS,
              })
            : connect.field === "maxImagesPerPrompt"
              ? t("Enter a whole number from 1 to 1000 for the image limit.")
              : t("Enter a whole number from 1 to {max} for the context limit.", {
                  max: MAX_MODEL_CONTEXT_WINDOW,
                }),
      });
      return;
    }
    const { savingLimitOnly, activeModelId } = connect;
    setPending("connect");
    try {
      const saved = await rpc("models/connect", connect.input);
      credentialIdRef.current = saved.id;
      setCredentialId(saved.id);
      if (!limitsOnly) setApiKey("");
      if (!savingLimitOnly && (await finishConnecting(activeModelId, saved.id))) return;
      await load({ modelId });
      publishFeedback(anchor, { notice: t("Saved.") });
    } catch (err) {
      publishFeedback(anchor, {
        error: errorText(err, t("Could not connect this provider")),
      });
    } finally {
      setPending(null);
    }
  }

  async function finishSubscriptionSignIn(loginId: string, controller: AbortController) {
    await waitForModelOAuth(loginId, controller.signal, rpc);
    if (controller.signal.aborted) return;
    const saved = await rpc("models/finishOAuth", { loginId }, { signal: controller.signal });
    if (controller.signal.aborted) return;
    oauthLoginIdRef.current = null;
    credentialIdRef.current = saved.id;
    setCredentialId(saved.id);
    setOauth(null);
    if (await finishConnecting(selected?.id ?? modelId, saved.id)) return;
    await load({ modelId });
    if (controller.signal.aborted) return;
    publishFeedback("connection", { notice: t("Saved.") });
  }

  /** A connect started from a picker continues in that slot's picker for this connection. */
  async function finishConnecting(
    connectedModelId: string,
    connectedCredentialId: string,
  ): Promise<boolean> {
    if (!request?.onConnected || !connectedModelId) return false;
    const next = await request.onConnected({
      provider,
      modelId: connectedModelId,
      credentialId: connectedCredentialId,
    });
    if (next) router.replace(next);
    else router.back();
    return true;
  }

  async function startSubscriptionSignIn() {
    if (!selected) return;
    clearFeedback();
    setOauthPending(true);
    const controller = new AbortController();
    oauthAbortRef.current = controller;
    let waitingForCode = false;
    try {
      const started = await rpc(
        "models/beginOAuth",
        {
          provider: selected.provider,
          modelId: selected.id,
          thinkingLevel: clampCatalogThinkingLevel(
            thinkingLevel,
            selected.thinkingLevels,
          ) as ThinkingLevel | null,
          makeDefault,
          scope: target.scope,
          label: selected.providerName ?? selected.provider,
          credentialId: credentialIdRef.current,
          codePage: true,
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
      publishFeedback("connection", {
        error: errorText(err, t("Could not start sign-in")),
      });
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
    clearFeedback();
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
      publishFeedback("connection", {
        error: errorText(err, t("Could not finish sign-in")),
      });
    } finally {
      oauthCodeSubmittingRef.current = false;
      if (!retryable) {
        finishModelOAuthAttempt(oauthAbortRef, controller, () => setOauthPending(false));
      }
    }
  }

  const feedback = error ? (
    <Text style={styles.error}>{error}</Text>
  ) : savedNotice ? (
    <Text style={styles.secondary}>{savedNotice}</Text>
  ) : null;

  function disclosureRow(label: string, expanded: boolean, onPress: () => void) {
    return (
      <View style={styles.card}>
        <SettingsRow
          title={label}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          chevron={expanded ? "down" : "right"}
          onPress={onPress}
        />
      </View>
    );
  }

  function limitField(
    label: string,
    value: string,
    onChangeText: (next: string) => void,
    maxLength: number,
  ) {
    return (
      <View>
        <Text style={styles.sectionTitle}>{label}</Text>
        <TextInput
          accessibilityLabel={label}
          editable={!busy}
          keyboardType="number-pad"
          maxLength={maxLength}
          onChangeText={onChangeText}
          style={styles.keyInput}
          value={value}
        />
      </View>
    );
  }

  const savedHeaderEndpointMatches = savedCompatibleEndpointMatches(baseUrl, credential?.baseUrl);
  const visibleHeaderRows =
    headerRows ??
    (savedHeaderEndpointMatches ? (credential?.headerNames ?? []) : []).map((name) => ({
      name,
      value: "",
    }));
  function changeHeaderRows(rows: ModelHeaderRow[]) {
    setHeaderRows(rows);
    resetOpenAiCompatibleProbe();
    clearFeedback();
  }

  const compatConfig = isOpenAiCompatible ? (
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
      <NativeActionButton
        disabled={busy || probing || !effectiveBaseUrl}
        fill
        label={probing ? t("Finding…") : t("Find models")}
        onPress={() => void probeServerModels()}
        prominence="secondary"
        style={{ marginTop: 12 }}
      />
      {!isOllamaCloudBaseUrl(baseUrl) ? (
        <>
          {disclosureRow(t("Setup help"), showEndpointHelp, () =>
            setShowEndpointHelp((visible) => !visible),
          )}
          {showEndpointHelp ? (
            <Text style={styles.hint}>{t(OPENAI_COMPATIBLE_BASE_URL_HINT)}</Text>
          ) : null}
        </>
      ) : null}
      <MenuPickerMenu
        label={t("Protocol")}
        choices={protocolChoices}
        value={apiProtocol}
        disabled={busy}
        onChange={(value) => {
          updateApiProtocol(value as ModelApiProtocol);
        }}
      >
        <View>
          <SettingsRow
            title={t("Protocol")}
            value={apiProtocolLabel}
            chevron="down"
            accessibilityRole="button"
            accessible
            accessibilityLabel={t("Protocol")}
            accessibilityState={{ disabled: busy }}
            accessibilityValue={{ text: apiProtocolLabel }}
          />
        </View>
      </MenuPickerMenu>
      {feedbackAnchor === "probe" ? feedback : null}
      <Text style={[styles.sectionTitle, { marginTop: 12 }]}>{t("Model")}</Text>
      {/* The switches stay visible while the default is "Other model…" or a typed id. */}
      {compatibleRows.length ? (
        <View style={styles.card}>
          {compatibleRows.map((entry) => (
            // The switch sits beside the radio, not inside it: an accessible
            // Pressable would merge it into the row and hide it from VoiceOver.
            <View key={entry} style={styles.modelRow}>
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: entry === modelId }}
                disabled={probing}
                onPress={() => stageCompatibleModelId(entry)}
                style={({ pressed }) => [
                  styles.modelRowChoice,
                  probing && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.modelLabel}>{entry}</Text>
                {entry === modelId ? <Checkmark /> : null}
              </Pressable>
              <NativeSwitch
                accessibilityLabel={entry}
                value={entry === modelId || enabledModelIds.includes(entry)}
                onValueChange={(value) =>
                  setEnabledModelIds((current) => toggleEnabledModelId(current, entry, value))
                }
                disabled={busy || entry === modelId}
              />
            </View>
          ))}
          {compatibleRows.includes(modelId) ? (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: false }}
              disabled={probing}
              onPress={() => stageCompatibleModelId("")}
              style={({ pressed }) => [
                styles.modelRow,
                probing && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.modelLabel}>{t("Other model…")}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {compatibleRows.includes(modelId) ? null : (
        <>
          <TextInput
            accessibilityLabel={t("Model id")}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy && !probing}
            onChangeText={stageCompatibleModelId}
            placeholder={t("exact-model-id")}
            placeholderTextColor={native.tertiaryLabel}
            style={styles.keyInput}
            value={modelId}
          />
          {probeModels.length ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => stageCompatibleModelId(probeModels[0] ?? "")}
              style={({ pressed }) => [pressed && styles.pressed]}
            >
              <Text style={styles.textAction}>{t("Use a found model")}</Text>
            </Pressable>
          ) : null}
        </>
      )}
      {disclosureRow(t("Advanced"), showAdvanced, () => setShowAdvanced((visible) => !visible))}
      {showAdvanced ? (
        <>
          <View style={styles.card}>
            <View style={styles.modelRow}>
              <Text style={styles.modelLabel}>{t("Supports thinking")}</Text>
              <NativeSwitch
                accessibilityLabel={t("Supports thinking")}
                value={reasoning}
                onValueChange={(value) => {
                  setReasoning(value);
                  if (!value) setThinkingLevel(null);
                }}
                disabled={busy}
              />
            </View>
            {reasoning ? (
              <MenuPickerMenu
                label={t("Reasoning effort")}
                choices={[
                  { key: "", label: t("Default") },
                  ...compatibleThinkingLevels(apiProtocol).map((level) => ({
                    key: level,
                    label: thinkingLevelLabel(level, t),
                  })),
                ]}
                value={thinkingLevel ?? ""}
                disabled={busy}
                onChange={(value) => setThinkingLevel((value || null) as ThinkingLevel | null)}
              >
                <View>
                  <SettingsRow
                    title={t("Reasoning effort")}
                    value={reasoningEffortValue}
                    chevron="down"
                    accessibilityRole="button"
                    accessible
                    accessibilityLabel={t("Reasoning effort")}
                    accessibilityState={{ disabled: busy }}
                    accessibilityValue={{ text: reasoningEffortValue }}
                  />
                </View>
              </MenuPickerMenu>
            ) : null}
            <View style={[styles.modelRow, styles.singleRow]}>
              <Text style={styles.modelLabel}>{t("Supports images")}</Text>
              <NativeSwitch
                accessibilityLabel={t("Supports images")}
                value={supportsImages}
                onValueChange={setSupportsImages}
                disabled={busy}
              />
            </View>
          </View>
          <HeaderRowsEditor
            rows={visibleHeaderRows}
            onChange={changeHeaderRows}
            disabled={busy}
            savedValuePlaceholder={(row) =>
              savedHeaderEndpointMatches && (credential?.headerNames?.includes(row.name) ?? false)
            }
          />
          {limitField(
            t("Context limit"),
            contextWindow,
            setContextWindow,
            String(MAX_MODEL_CONTEXT_WINDOW).length,
          )}
          {limitField(
            t("Maximum output tokens"),
            maxTokens,
            (value) => {
              setMaxTokens(value);
              clearFeedback();
            },
            String(MAX_MODEL_MAX_TOKENS).length,
          )}
          {supportsImages
            ? limitField(
                t("Maximum images per request"),
                maxImagesPerPrompt,
                setMaxImagesPerPrompt,
                4,
              )
            : null}
        </>
      ) : null}
    </>
  ) : null;

  const serverCredentialsNote = (
    <Text style={styles.secondary}>
      {t("Uses this server's own {source} credentials to access {provider}.", {
        source: me?.hostCredentialSource ?? "",
        provider: selected?.providerName ?? provider,
      })}
    </Text>
  );

  const compatKeySection =
    isOpenAiCompatible && acceptsKey ? (
      <View style={styles.keySection}>
        {isOllamaCloudBaseUrl(baseUrl) ? (
          <Text style={styles.sectionTitle}>{t("API key")}</Text>
        ) : (
          disclosureRow(t("API key"), showApiKey, () => setShowApiKey((visible) => !visible))
        )}
        {showApiKey || isOllamaCloudBaseUrl(baseUrl) ? (
          <TextInput
            accessibilityLabel={t("API key")}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            editable={!busy}
            importantForAutofill="no"
            onChangeText={updateApiKey}
            placeholder={
              isOllamaCloudBaseUrl(baseUrl)
                ? t("Ollama API key")
                : credential?.hasKey
                  ? t("Paste a replacement key")
                  : t("Optional")
            }
            placeholderTextColor={native.tertiaryLabel}
            secureTextEntry
            style={styles.keyInput}
            textContentType="none"
            value={apiKey}
          />
        ) : null}

        <NativeActionButton
          disabled={
            busy || (isOpenAiCompatible ? !openAiCompatibleReady : apiKey.trim().length < 8)
          }
          label={
            pending === "connect"
              ? t("Saving…")
              : isOpenAiCompatible
                ? t("Save")
                : credential
                  ? t("Replace API key")
                  : t("Connect API key")
          }
          onPress={() => void connectKey()}
          style={{ marginTop: 12 }}
        />
      </View>
    ) : null;

  // Managing a connection keeps its model choice in the list that opened it.
  // Keys belong to the provider: models are picked in the list, limits only once connected.
  const catalogModelCard =
    !isOpenAiCompatible && selected && credential ? (
      <>
        {disclosureRow(t("Advanced"), showAdvanced, () => setShowAdvanced((visible) => !visible))}
        {showAdvanced ? (
          <>
            {limitField(
              t("Maximum output tokens"),
              maxTokens,
              (value) => {
                setMaxTokens(value);
                clearFeedback();
              },
              String(MAX_MODEL_MAX_TOKENS).length,
            )}
            {credential && limitsDirty ? (
              <NativeActionButton
                disabled={busy || !cloudflareRoutingReady}
                label={
                  pending === "connect" && feedbackAnchor === "limits" ? t("Saving…") : t("Save")
                }
                onPress={() => void connectKey(true)}
                prominence="secondary"
                style={{ marginTop: 12 }}
              />
            ) : null}
            {feedbackAnchor === "limits" ? feedback : null}
          </>
        ) : null}
      </>
    ) : null;

  const catalogConnectionControls =
    !isOpenAiCompatible && selected ? (
      <>
        {subscriptionSignIn ? (
          oauth ? (
            <View style={styles.oauthCard}>
              {oauth.mode === "auth-url" ? (
                <>
                  <Text style={styles.secondary}>{t("Finish signing in in your browser:")}</Text>
                  <Pressable onPress={() => void Linking.openURL(oauth.verificationUri)}>
                    <Text style={styles.link}>{oauth.verificationUri}</Text>
                  </Pressable>
                  <Text style={styles.secondary}>{t("Then paste the code here.")}</Text>
                  <TextInput
                    accessibilityLabel={t("Authorization code")}
                    value={pasteCode}
                    onChangeText={setPasteCode}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[styles.keyInput, styles.nestedInput]}
                  />
                  <NativeActionButton
                    disabled={!pasteCode.trim()}
                    fill
                    label={t("Submit")}
                    onPress={() => void submitOAuthCode()}
                    prominence="secondary"
                    style={{ marginTop: 12 }}
                  />
                  <Text style={styles.secondary}>
                    {t("Waiting for sign-in — the link expires in about {minutes} minutes.", {
                      minutes: Math.ceil(oauth.expiresInSeconds / 60),
                    })}
                  </Text>
                </>
              ) : (
                <>
                  <Text style={styles.secondary}>
                    {t("A sign-in page opened — enter this code there:")}
                  </Text>
                  <Pressable onPress={() => void Linking.openURL(oauth.verificationUri)}>
                    <Text style={styles.link}>{oauth.verificationUri}</Text>
                  </Pressable>
                  <Text style={styles.code}>{oauth.userCode}</Text>
                  <NativeActionButton
                    fill
                    label={codeCopied ? t("Copied") : t("Copy")}
                    onPress={() => copyOAuthCode(oauth.userCode)}
                    prominence="secondary"
                    style={{ marginTop: 12 }}
                  />
                  <Text style={styles.secondary}>
                    {t("Waiting for sign-in — the code expires in about {minutes} minutes.", {
                      minutes: Math.ceil(oauth.expiresInSeconds / 60),
                    })}
                  </Text>
                </>
              )}
              <NativeActionButton
                fill
                label={t("Cancel")}
                onPress={() => cancelOAuth()}
                prominence="secondary"
                style={{ marginTop: 12 }}
              />
            </View>
          ) : (
            <NativeActionButton
              disabled={busy}
              fill
              label={
                oauthPending
                  ? t("Starting…")
                  : credential
                    ? t("Sign in again")
                    : (selected.oauthLabel ?? t("Sign in"))
              }
              onPress={() => void startSubscriptionSignIn()}
              prominence="secondary"
              style={{ marginTop: 12 }}
            />
          )
        ) : null}
        {acceptsKey || isCloudflare ? (
          <View style={styles.keySection}>
            {isCloudflare ? (
              <>
                <Text style={styles.sectionTitle}>{t("Account ID")}</Text>
                <TextInput
                  accessibilityLabel={t("Account ID")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  editable={!busy}
                  onChangeText={(value) => {
                    setAccountId(value);
                    clearFeedback();
                  }}
                  style={styles.keyInput}
                  value={accountId}
                />
                {isCloudflareGateway ? (
                  <>
                    <Text style={styles.sectionTitle}>{t("Gateway ID")}</Text>
                    <TextInput
                      accessibilityLabel={t("Gateway ID")}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="off"
                      editable={!busy}
                      onChangeText={(value) => {
                        setGatewayId(value);
                        clearFeedback();
                      }}
                      style={styles.keyInput}
                      value={gatewayId}
                    />
                  </>
                ) : null}
              </>
            ) : null}
            {acceptsKey ? (
              <>
                <Text style={styles.sectionTitle}>
                  {!credential && subscriptionSignIn ? t("Or connect an API key") : t("API key")}
                </Text>
                <TextInput
                  accessibilityLabel={t("API key")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  editable={!busy}
                  importantForAutofill="no"
                  onChangeText={updateApiKey}
                  placeholder={credential?.hasKey ? t("Paste a replacement key") : t("sk-…")}
                  placeholderTextColor={native.tertiaryLabel}
                  secureTextEntry
                  style={styles.keyInput}
                  textContentType="none"
                  value={apiKey}
                />
              </>
            ) : null}

            <NativeActionButton
              disabled={
                busy ||
                !cloudflareRoutingReady ||
                (gatewayOnlySave ? !gatewayDirty : apiKey.trim().length < 8)
              }
              label={
                pending === "connect" && feedbackAnchor === "connection"
                  ? t("Saving…")
                  : gatewayOnlySave
                    ? t("Save")
                    : credential
                      ? t("Replace API key")
                      : t("Connect API key")
              }
              onPress={() => void connectKey()}
              prominence={credential ? "secondary" : "primary"}
              style={{ marginTop: 12 }}
            />
          </View>
        ) : null}
        {selected.auth === "oauth" && !subscriptionSignIn ? (
          <Text style={styles.secondary}>
            {t(
              "This subscription sign-in is not available in Rakazo yet. Use a deployment credential or choose another provider.",
            )}
          </Text>
        ) : null}
      </>
    ) : null;

  const connectedStatusRow = credential ? (
    <View style={styles.statusRow}>
      <View style={styles.providerCopy}>
        <Text style={styles.secondary}>{t("Connected")}</Text>
      </View>
      <NativeActionButton
        disabled={busy}
        fill={false}
        label={pending === "disconnect" ? t("Disconnecting…") : t("Disconnect")}
        onPress={() => {
          Alert.alert(
            t("Disconnect {name}?", { name: selectedProviderLabel }),
            t("This removes the connection from every space."),
            [
              { text: t("Cancel"), style: "cancel" },
              {
                text: t("Disconnect"),
                style: "destructive",
                onPress: () => void disconnectCredential(),
              },
            ],
          );
        }}
        prominence="destructive"
        variant="text"
      />
    </View>
  ) : null;
  if (loading && catalog.length === 0) {
    return (
      <SafeAreaView edges={["bottom"]} style={[styles.screen, styles.centered]}>
        <ActivityIndicator color={native.secondaryLabel} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
      >
        {selected ? (
          isOpenAiCompatible ? (
            <>
              {compatConfig}
              {compatKeySection}
              {feedbackAnchor === "probe" ? null : feedback}
              {connectedStatusRow}
            </>
          ) : credential ? (
            <>
              {provider === me?.hostCredentialProvider ? serverCredentialsNote : null}
              {connectedStatusRow}
              {catalogConnectionControls}
              {feedbackAnchor === "connection" ? feedback : null}
              {catalogModelCard}
            </>
          ) : provider === me?.hostCredentialProvider ? (
            <>
              {serverCredentialsNote}
              {disclosureRow(t("Use your own key"), ownKeyProvider === provider, () =>
                setOwnKeyProvider((current) => (current === provider ? null : provider)),
              )}
              {ownKeyProvider === provider ? (
                <>
                  {catalogConnectionControls}
                  {feedback}
                  {catalogModelCard}
                </>
              ) : null}
            </>
          ) : (
            <>
              {catalogConnectionControls}
              {feedback}
              {catalogModelCard}
            </>
          )
        ) : (
          feedback
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function createModelsStyles() {
  const tokens = mobileTokens();
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
      width: "100%",
      padding: 20,
      gap: 12,
      paddingBottom: 40,
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
    providerCopy: {
      flex: 1,
    },
    statusRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      marginTop: 8,
      marginBottom: 16,
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
    modelRowChoice: {
      flex: 1,
      alignSelf: "stretch",
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    modelLabel: {
      flex: 1,
      color: native.label,
      fontSize: 15,
    },
    singleRow: {
      borderBottomWidth: 0,
    },
    hint: {
      color: native.secondaryLabel,
      fontSize: 13,
      lineHeight: 19,
      marginTop: 4,
    },
    textAction: {
      color: native.secondaryLabel,
      fontSize: 15,
      marginTop: 8,
    },
    oauthCard: {
      borderRadius: 14,
      backgroundColor: native.fill,
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
    nestedInput: {
      // The OAuth card is already a fill; the page color keeps the field visible on it.
      backgroundColor: native.page,
    },
    keySection: {
      marginTop: 4,
    },
    keyInput: {
      minHeight: 48,
      borderRadius: 12,
      backgroundColor: native.fill,
      color: native.label,
      paddingHorizontal: 14,
      paddingVertical: 10,
      marginTop: 4,
      fontSize: 16,
    },
    error: {
      color: tokens.destructive,
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
