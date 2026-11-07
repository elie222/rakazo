import type {
  ModelApiProtocol,
  ModelAuthMode,
  ModelHeaderRow,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  compatibleEndpointPresets,
  connectionDisplayName,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  MAX_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_MAX_TOKENS,
  matchCompatibleEndpointPreset,
  modelHeadersInput,
  modelRoutingForm,
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
} from "@rakazo/core";
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
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CompatibleEndpointForm } from "../../components/compatible-endpoint-form";
import { DisclosureRow, LimitField } from "../../components/model-connection-fields";
import { createModelsStyles } from "../../components/model-connection-styles";
import { NativeActionButton } from "../../components/native-action-button";
import { useI18n } from "../../lib/i18n";
import type { MobileMe, MobileModel, MobileModelCredential } from "../../lib/mobile-types";
import {
  MODEL_CONNECT_TIMEOUT_MS,
  modelConnectionRequest,
} from "../../lib/model-connection-request";
import { native, useThemedStyles } from "../../lib/native";
import { ACCOUNT_SETTINGS, settingsRpc } from "../../lib/settings-target";
import { useListSearch } from "../../lib/use-list-search";
import { useSubscriptionSignIn } from "../../lib/use-subscription-sign-in";
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
  const [authMode, setAuthMode] = useState<ModelAuthMode>("bearer");
  const [label, setLabel] = useState("");
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
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"connect" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const meRef = useRef<MobileMe | null>(null);
  meRef.current = me;
  const [feedbackAnchor, setFeedbackAnchor] = useState<FeedbackAnchor>("connection");

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
      setAuthMode(fields.authMode);
      setLabel(fields.label);
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

  const modelsForProvider = catalog.filter((entry) => entry.provider === provider);
  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  const credential = credentials.find((entry) => entry.id === credentialId);
  const {
    oauth,
    pasteCode,
    setPasteCode,
    oauthPending,
    codeCopied,
    copyOAuthCode,
    cancelOAuth,
    cancelSignIn,
    startSubscriptionSignIn,
    submitOAuthCode,
  } = useSubscriptionSignIn({
    rpc,
    selected,
    thinkingLevel,
    makeDefault,
    scope: target.scope,
    credentialIdRef,
    setCredentialId,
    modelId,
    load,
    finishConnecting,
    publishFeedback,
    clearFeedback,
  });

  const cancelInFlightWork = useCallback(() => {
    modelProbe.invalidate();
    cancelSignIn();
  }, [cancelSignIn, modelProbe]);

  useEffect(
    () => () => {
      cancelInFlightWork();
    },
    [cancelInFlightWork],
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

  const providerName = selected?.providerName ?? selected?.provider ?? "";
  const endpointPreset =
    provider === OPENAI_COMPATIBLE_PROVIDER_ID
      ? matchCompatibleEndpointPreset(compatibleEndpointPresets(catalog), baseUrl)
      : undefined;
  const selectedProviderLabel = credential
    ? connectionDisplayName(credential, providerName)
    : (endpointPreset?.name ?? providerName);
  useLayoutEffect(() => {
    if (selectedProviderLabel) navigation.setOptions({ title: selectedProviderLabel });
  }, [navigation, selectedProviderLabel]);
  const isOpenAiCompatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const { needsRouting, needsGateway, routingReady } = modelRoutingForm(selected?.routingFields, {
    accountId,
    gatewayId,
  });
  const compatibleRows = compatibleModelRows(
    savedCompatibleModelIds(credential, baseUrl),
    enabledModelIds,
    probeModels,
  );
  const search = useListSearch(compatibleRows, {
    text: (id) => id,
    id: (id) => id,
    selectedIds: [modelId, ...enabledModelIds],
  });
  const acceptsKey = selected?.auth !== "oauth";
  const subscriptionSignIn = selected?.signIn !== undefined;
  const busy = pending !== null || oauthPending;
  const openAiCompatibleReady = compatibleConnectionReady({
    apiKey,
    baseUrl,
    modelId,
    headerRows,
    credential,
    keyRequired: Boolean(endpointPreset),
  });
  const limitsDirty = maxTokens !== connectionMaxTokensField(provider, credential?.maxTokens);
  const gatewayDirty =
    accountId.trim() !== (credential?.accountId ?? "") ||
    gatewayId.trim() !== (credential?.gatewayId ?? "");
  const gatewayOnlySave = needsRouting && Boolean(credential) && !apiKey.trim();

  function updateBaseUrl(nextBaseUrl: string) {
    setBaseUrl(nextBaseUrl);
    setHeaderRows(null);
    // A new endpoint starts with no model or ticks; the saved endpoint gets its saved ones back.
    setEnabledModelIds(savedCompatibleModelIds(credential, nextBaseUrl));
    stageCompatibleModelId(
      savedCompatibleEndpointMatches(nextBaseUrl, credential?.baseUrl)
        ? (credential?.modelId ?? "")
        : "",
    );
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

  function updateAuthMode(nextAuthMode: ModelAuthMode) {
    setAuthMode(nextAuthMode);
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
        rpc(
          "models/probeOpenAiCompatible",
          {
            ...input,
            apiProtocol,
            authMode,
            headers: modelHeadersInput(headerRows),
            credentialId: credential?.id,
          },
          { timeoutMs: MODEL_CONNECT_TIMEOUT_MS },
        ),
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
        authMode,
        label,
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
      const saved = await rpc("models/connect", connect.input, {
        timeoutMs: MODEL_CONNECT_TIMEOUT_MS,
      });
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

  const feedback = error ? (
    <Text style={styles.error}>{error}</Text>
  ) : savedNotice ? (
    <Text style={styles.secondary}>{savedNotice}</Text>
  ) : null;

  function toggleAdvanced() {
    setShowAdvanced((visible) => !visible);
  }

  function changeMaxTokens(value: string) {
    setMaxTokens(value);
    clearFeedback();
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
    <CompatibleEndpointForm
      busy={busy}
      probing={probing}
      baseUrl={baseUrl}
      onChangeBaseUrl={updateBaseUrl}
      onFindModels={() => void probeServerModels()}
      hasPreset={Boolean(endpointPreset)}
      showEndpointHelp={showEndpointHelp}
      onToggleEndpointHelp={() => setShowEndpointHelp((visible) => !visible)}
      apiProtocol={apiProtocol}
      onChangeProtocol={updateApiProtocol}
      authMode={authMode}
      onChangeAuthMode={updateAuthMode}
      label={label}
      onChangeLabel={setLabel}
      probeFeedback={feedbackAnchor === "probe" ? feedback : null}
      search={search}
      compatibleRows={compatibleRows}
      modelId={modelId}
      onSelectModel={stageCompatibleModelId}
      enabledModelIds={enabledModelIds}
      setEnabledModelIds={setEnabledModelIds}
      probeModels={probeModels}
      showAdvanced={showAdvanced}
      onToggleAdvanced={toggleAdvanced}
      reasoning={reasoning}
      setReasoning={setReasoning}
      thinkingLevel={thinkingLevel}
      setThinkingLevel={setThinkingLevel}
      supportsImages={supportsImages}
      setSupportsImages={setSupportsImages}
      headerRows={visibleHeaderRows}
      onChangeHeaderRows={changeHeaderRows}
      savedHeaderPlaceholder={(row) =>
        savedHeaderEndpointMatches && (credential?.headerNames?.includes(row.name) ?? false)
      }
      contextWindow={contextWindow}
      setContextWindow={setContextWindow}
      maxTokens={maxTokens}
      onChangeMaxTokens={changeMaxTokens}
      maxImagesPerPrompt={maxImagesPerPrompt}
      setMaxImagesPerPrompt={setMaxImagesPerPrompt}
    />
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
        {endpointPreset ? (
          <Text style={styles.sectionTitle}>{t("API key")}</Text>
        ) : (
          <DisclosureRow
            label={t("API key")}
            expanded={showApiKey}
            onPress={() => setShowApiKey((visible) => !visible)}
          />
        )}
        {showApiKey || endpointPreset ? (
          <TextInput
            accessibilityLabel={t("API key")}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            editable={!busy}
            importantForAutofill="no"
            onChangeText={updateApiKey}
            placeholder={
              credential?.hasKey
                ? t("Paste a replacement key")
                : endpointPreset
                  ? undefined
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
        <DisclosureRow label={t("Advanced")} expanded={showAdvanced} onPress={toggleAdvanced} />
        {showAdvanced ? (
          <>
            <LimitField
              label={t("Maximum output tokens")}
              value={maxTokens}
              onChangeText={changeMaxTokens}
              maxLength={String(MAX_MODEL_MAX_TOKENS).length}
              busy={busy}
            />
            {credential && limitsDirty ? (
              <NativeActionButton
                disabled={busy || !routingReady}
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
        {acceptsKey || needsRouting ? (
          <View style={styles.keySection}>
            {needsRouting ? (
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
                {needsGateway ? (
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
                !routingReady ||
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
              <DisclosureRow
                label={t("Use your own key")}
                expanded={ownKeyProvider === provider}
                onPress={() =>
                  setOwnKeyProvider((current) => (current === provider ? null : provider))
                }
              />
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
