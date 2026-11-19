import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useCompatibleModelDiscovery } from "@rakazo/chat-ui/model-discovery";
import type { ModelApiProtocol, ModelHeaderRow, ThinkingLevel } from "@rakazo/contracts";
import {
  compatibleEndpointPresets,
  connectionDisplayName,
  matchCompatibleEndpointPreset,
  modelRoutingDirty,
  modelRoutingForm,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  savedCompatibleEndpointMatches,
} from "@rakazo/contracts";
import {
  compatibleConnectionReady,
  compatibleModelRows,
  connectionFormFields,
  connectionFormModelId,
  connectionModels,
  dataRetentionDirty,
  modelConnectionFormSecrets,
  modelConnectRequest,
  sameCompatibleModelEndpoint,
  sanitizeModelConnectionError,
  savedCompatibleModelIds,
} from "@rakazo/core";
import { useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Keyboard,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CompatibleEndpointForm } from "../../components/models/compatible-endpoint-form";
import { ConnectionModelList } from "../../components/models/connection-model-list";
import { DisclosureRow } from "../../components/models/model-connection-fields";
import { createModelsStyles } from "../../components/models/model-connection-styles";
import { NativeActionButton } from "../../components/native/native-action-button";
import { SettingsGroup, SettingsSwitch } from "../../components/settings/settings-group";
import { MenuPicker } from "../../components/ui/menu-picker";
import type { MobileMe, MobileModel, MobileModelCredential } from "../../lib/api/mobile-types";
import { errorText } from "../../lib/api/user-error";
import { useSubscriptionSignIn } from "../../lib/auth/use-subscription-sign-in";
import {
  MODEL_CONNECT_TIMEOUT_MS,
  modelConnectionRequest,
} from "../../lib/models/model-connection-request";
import { analyticsSurface } from "../../lib/native/analytics-surface";
import { native, useThemedStyles } from "../../lib/native/native";
import { useScreenHeader } from "../../lib/navigation/screen-header";
import { ACCOUNT_SETTINGS, settingsRpc } from "../../lib/query/settings-target";
import { useListSearch } from "../../lib/search/use-list-search";

type ModelSelection = {
  modelId?: string;
};

type FeedbackAnchor = "model" | "connection";

/** Connects or manages one provider for the model list that opened it. */
export default function ModelConnection() {
  const styles = useThemedStyles(createModelsStyles);
  const router = useRouter();
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
  const { t } = useLingui();
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
  const [projectId, setProjectId] = useState("");
  const [region, setRegion] = useState("global");
  const [zeroDataRetention, setZeroDataRetention] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiProtocol, setApiProtocol] = useState<ModelApiProtocol>("chat-completions");
  const [headerRows, setHeaderRows] = useState<ModelHeaderRow[] | null>(null);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"connect" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const credential = credentials.find((entry) => entry.id === credentialId);
  const focused = useIsFocused();
  const isOpenAiCompatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const endpointPresets = isOpenAiCompatible ? compatibleEndpointPresets(catalog) : [];
  const endpointPreset = matchCompatibleEndpointPreset(
    endpointPresets,
    request?.baseUrl ?? credential?.baseUrl,
  );
  const matchedEndpoint = matchCompatibleEndpointPreset(endpointPresets, baseUrl);
  const compatibleKeyRequired = Boolean(matchedEndpoint);
  const {
    discoverModels,
    modelProbe,
    probeError,
    probeModels,
    probing,
    resetOpenAiCompatibleProbe,
  } = useCompatibleModelDiscovery(
    focused && isOpenAiCompatible
      ? { baseUrl, apiKey, apiProtocol, headerRows, preset: matchedEndpoint, credential }
      : null,
    {
      request: (input) =>
        rpc("models/probeOpenAiCompatible", input, { timeoutMs: MODEL_CONNECT_TIMEOUT_MS }),
      onModels: (models) => setModelId((current) => current.trim() || models[0] || ""),
      errorMessage: (err) => connectionErrorText(err, t`Could not reach this model server`),
    },
  );

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
    setSavedNotice(next.notice === t`Saved.` ? next.notice : null);
    const message = nextError ?? next.notice ?? null;
    // VoiceOver keeps focus on the tapped button, so speak the result from here.
    if (message) AccessibilityInfo.announceForAccessibility(message);
  }

  function clearFeedback() {
    setFeedbackAnchor("connection");
    setError(null);
    setSavedNotice(null);
  }

  const loadGeneration = useRef(0);

  const load = useCallback(
    async (preferred: ModelSelection = {}) => {
      if (!request) throw new Error(t`Could not load model settings`);
      const generation = ++loadGeneration.current;
      setError(null);
      const [nextMe, nextCatalog, nextCredentials] = await Promise.all([
        rpc("me"),
        rpc("models/list"),
        rpc("models/credentials"),
      ]);
      if (generation !== loadGeneration.current) return nextMe;
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
      setThinkingLevel(fields.thinkingLevel);
      setAccountId(fields.accountId);
      setGatewayId(fields.gatewayId);
      setProjectId(fields.projectId ?? "");
      setRegion(fields.region ?? "global");
      setZeroDataRetention(fields.zeroDataRetention ?? false);
      return nextMe;
    },
    [request, resetOpenAiCompatibleProbe, rpc, t],
  );

  function adoptSavedCredential(saved: MobileModelCredential) {
    ++loadGeneration.current;
    setCredentials((current) => [...current.filter((entry) => entry.id !== saved.id), saved]);
  }

  const modelsForProvider = catalog.filter((entry) => entry.provider === provider);
  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  const {
    oauth,
    pasteCode,
    setPasteCode,
    oauthPending,
    codeCopied,
    copyOAuthCode,
    cancelOAuth,
    cancelSignIn,
    openSignInPage,
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
    onSaved: adoptSavedCredential,
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
      let active = true;
      const pendingLoad = load();
      const generation = loadGeneration.current;
      const isCurrent = () => active && generation === loadGeneration.current;
      void pendingLoad
        .catch((err: unknown) => {
          if (isCurrent()) {
            publishFeedback("connection", {
              error: errorText(err, t`Could not load model settings`),
            });
          }
        })
        .finally(() => {
          if (isCurrent()) setLoading(false);
        });
      return () => {
        active = false;
        cancelInFlightWork();
      };
    }, [cancelInFlightWork, load]),
  );

  const providerName = selected?.providerName ?? selected?.provider ?? "";
  const selectedProviderLabel = credential
    ? connectionDisplayName(credential, providerName)
    : (endpointPreset?.name ?? providerName);
  useScreenHeader({ title: selectedProviderLabel || undefined });
  const { needsRouting, needsGateway, needsProject, routingReady } = modelRoutingForm(
    selected?.routingFields,
    {
      accountId,
      gatewayId,
      projectId,
      region,
    },
    credential,
  );
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
    keyRequired: compatibleKeyRequired,
  });
  const retentionDirty =
    selected !== undefined && dataRetentionDirty(selected, zeroDataRetention, credential);
  const gatewayDirty =
    modelRoutingDirty({ accountId, gatewayId, projectId, region }, credential) || retentionDirty;
  const gatewayOnlySave = (needsRouting || retentionDirty) && Boolean(credential) && !apiKey.trim();

  function updateBaseUrl(nextBaseUrl: string) {
    setBaseUrl(nextBaseUrl);
    if (sameCompatibleModelEndpoint(baseUrl, nextBaseUrl)) return;
    // A typed key belongs to the endpoint it was entered for.
    if (baseUrl.trim()) setApiKey("");
    setHeaderRows(null);
    // A new endpoint starts with no model or ticks; the saved endpoint gets its saved ones back.
    setEnabledModelIds(savedCompatibleModelIds(credential, nextBaseUrl));
    setModelId(
      savedCompatibleEndpointMatches(nextBaseUrl, credential?.baseUrl)
        ? (credential?.modelId ?? "")
        : "",
    );
    resetOpenAiCompatibleProbe();
    clearFeedback();
  }

  function updateApiProtocol(nextProtocol: ModelApiProtocol) {
    setApiProtocol(nextProtocol);
    resetOpenAiCompatibleProbe();
    clearFeedback();
  }

  function updateApiKey(nextApiKey: string) {
    setApiKey(nextApiKey);
    if (!matchedEndpoint?.publicModels && nextApiKey.trim() !== apiKey.trim()) {
      resetOpenAiCompatibleProbe();
    }
    clearFeedback();
  }

  function connectionErrorText(err: unknown, fallback: string): string {
    return sanitizeModelConnectionError(
      errorText(err, fallback),
      modelConnectionFormSecrets({ apiKey, headerRows }),
    );
  }

  async function disconnectCredential() {
    if (!selected || !credential) return;
    cancelOAuth();
    clearFeedback();
    setPending("disconnect");
    try {
      await rpc("models/disconnect", { provider: selected.provider, credentialId: credential.id });
      publishFeedback("connection", {
        notice: t`Disconnected ${ph({ provider: selectedProviderLabel })}.`,
      });
      router.back();
    } catch (err) {
      publishFeedback("connection", {
        error: errorText(err, t`Could not disconnect this provider`),
      });
    } finally {
      setPending(null);
    }
  }

  async function connectKey() {
    if (!selected) return;
    const connect = modelConnectRequest({
      form: {
        apiKey,
        modelId,
        enabledModelIds,
        baseUrl,
        apiProtocol,
        headerRows,
        thinkingLevel,
        accountId,
        gatewayId,
        projectId,
        region,
        zeroDataRetention,
      },
      selected,
      credential,
      credentialId: credentialIdRef.current,
      makeDefault: { makeDefault, scope: target.scope },
    });
    if (connect.status === "incomplete") return;
    Keyboard.dismiss();
    clearFeedback();
    const { savingWithoutKey, activeModelId } = connect;
    setPending("connect");
    try {
      const saved = await rpc(
        "models/connect",
        { ...connect.input, surface: analyticsSurface() },
        { timeoutMs: MODEL_CONNECT_TIMEOUT_MS },
      );
      adoptSavedCredential(saved);
      credentialIdRef.current = saved.id;
      setCredentialId(saved.id);
      setHeaderRows(null);
      setApiKey("");
      let refreshGeneration = loadGeneration.current;
      try {
        if (!savingWithoutKey && (await finishConnecting(activeModelId, saved.id))) return;
        const refresh = load({ modelId });
        refreshGeneration = loadGeneration.current;
        await refresh;
        if (refreshGeneration !== loadGeneration.current) return;
        publishFeedback("connection", { notice: t`Saved.` });
      } catch (err) {
        if (refreshGeneration !== loadGeneration.current) return;
        publishFeedback("connection", {
          error: errorText(err, t`Could not load model settings`),
        });
      }
    } catch (err) {
      publishFeedback("connection", {
        error: connectionErrorText(err, t`Could not connect this provider`),
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

  const serverCredentialsNote = (
    <Text style={styles.secondary}>
      {t`Uses this server's own ${ph({ source: me?.hostCredentialSource ?? "" })} credentials to access ${ph({ provider: selected?.providerName ?? provider })}.`}
    </Text>
  );

  const compatKeySection =
    isOpenAiCompatible && acceptsKey ? (
      <View style={styles.keySection}>
        {compatibleKeyRequired ? (
          <Text style={styles.sectionTitle}>{t`API key`}</Text>
        ) : (
          <DisclosureRow
            label={t`API key`}
            expanded={showApiKey}
            onPress={() => setShowApiKey((visible) => !visible)}
          />
        )}
        {showApiKey || compatibleKeyRequired ? (
          <TextInput
            accessibilityLabel={t`API key`}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            editable={!busy}
            importantForAutofill="no"
            onChangeText={updateApiKey}
            placeholder={
              credential?.hasKey
                ? t`Paste a replacement key`
                : compatibleKeyRequired
                  ? undefined
                  : t`Optional`
            }
            placeholderTextColor={native.tertiaryLabel}
            secureTextEntry
            style={styles.keyInput}
            textContentType="none"
            value={apiKey}
          />
        ) : null}
      </View>
    ) : null;

  const compatConfig = isOpenAiCompatible ? (
    <CompatibleEndpointForm
      busy={busy}
      probing={probing}
      baseUrl={baseUrl}
      onChangeBaseUrl={updateBaseUrl}
      hasPreset={Boolean(endpointPreset)}
      apiProtocol={apiProtocol}
      onChangeProtocol={updateApiProtocol}
      probeError={probeError}
      onRetryProbe={discoverModels}
      keyField={compatKeySection}
      showModelPicker={showModelPicker}
      onToggleModelPicker={() => setShowModelPicker((visible) => !visible)}
      showConnectionOptions={!endpointPreset || Boolean(credential)}
      search={search}
      compatibleRows={compatibleRows}
      modelId={modelId}
      onSelectModel={setModelId}
      enabledModelIds={enabledModelIds}
      setEnabledModelIds={setEnabledModelIds}
      probeModels={probeModels}
      showAdvanced={showAdvanced}
      onToggleAdvanced={toggleAdvanced}
      headerRows={visibleHeaderRows}
      onChangeHeaderRows={changeHeaderRows}
      savedHeaderPlaceholder={(row) =>
        savedHeaderEndpointMatches && (credential?.headerNames?.includes(row.name) ?? false)
      }
    />
  ) : null;

  const catalogConnectionControls =
    !isOpenAiCompatible && selected ? (
      <>
        {subscriptionSignIn ? (
          oauth ? (
            <View style={styles.oauthCard}>
              {oauth.mode === "auth-url" ? (
                <>
                  <Text style={styles.secondary}>{t`Finish signing in in your browser:`}</Text>
                  <Pressable onPress={() => void openSignInPage(oauth.verificationUri)}>
                    <Text style={styles.link}>{oauth.verificationUri}</Text>
                  </Pressable>
                  <Text style={styles.secondary}>{t`Then paste the code here.`}</Text>
                  <TextInput
                    accessibilityLabel={t`Authorization code`}
                    value={pasteCode}
                    onChangeText={setPasteCode}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[styles.keyInput, styles.nestedInput]}
                  />
                  <NativeActionButton
                    disabled={!pasteCode.trim()}
                    fill
                    label={t`Submit`}
                    onPress={() => void submitOAuthCode()}
                    prominence="secondary"
                    style={{ marginTop: 12 }}
                  />
                  <Text style={styles.secondary}>
                    {t`Waiting for sign-in — the link expires in about ${ph({ minutes: Math.ceil(oauth.expiresInSeconds / 60) })} minutes.`}
                  </Text>
                </>
              ) : (
                <>
                  <Text style={styles.secondary}>
                    {t`A sign-in page opened — enter this code there:`}
                  </Text>
                  <Pressable onPress={() => void openSignInPage(oauth.verificationUri)}>
                    <Text style={styles.link}>{oauth.verificationUri}</Text>
                  </Pressable>
                  <Text style={styles.code}>{oauth.userCode}</Text>
                  <NativeActionButton
                    fill
                    label={codeCopied ? t`Copied` : t`Copy`}
                    onPress={() => copyOAuthCode(oauth.userCode)}
                    prominence="secondary"
                    style={{ marginTop: 12 }}
                  />
                  <Text style={styles.secondary}>
                    {t`Waiting for sign-in — the code expires in about ${ph({ minutes: Math.ceil(oauth.expiresInSeconds / 60) })} minutes.`}
                  </Text>
                </>
              )}
              <NativeActionButton
                fill
                label={t`Cancel`}
                onPress={() => cancelOAuth()}
                prominence="secondary"
                style={{ marginTop: 12 }}
              />
            </View>
          ) : credential?.authKind !== "oauth" || credential.reconnectRequired ? (
            <NativeActionButton
              disabled={busy}
              fill
              label={
                oauthPending
                  ? t`Starting…`
                  : credential?.authKind === "oauth"
                    ? t`Sign in again`
                    : (selected.oauthLabel ?? t`Sign in`)
              }
              onPress={() => void startSubscriptionSignIn()}
              prominence="secondary"
              style={{ marginTop: 12 }}
            />
          ) : null
        ) : null}
        {acceptsKey || needsRouting ? (
          <View style={styles.keySection}>
            {needsRouting ? (
              <>
                <Text style={styles.sectionTitle}>
                  {needsProject ? t`Project ID` : t`Account ID`}
                </Text>
                <TextInput
                  accessibilityLabel={needsProject ? t`Project ID` : t`Account ID`}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  editable={!busy}
                  onChangeText={(value) => {
                    (needsProject ? setProjectId : setAccountId)(value);
                    clearFeedback();
                  }}
                  style={styles.keyInput}
                  value={needsProject ? projectId : accountId}
                />
                {needsGateway || needsProject ? (
                  <>
                    <Text style={styles.sectionTitle}>
                      {needsProject ? t`Region` : t`Gateway ID`}
                    </Text>
                    <TextInput
                      accessibilityLabel={needsProject ? t`Region` : t`Gateway ID`}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="off"
                      editable={!busy}
                      onChangeText={(value) => {
                        (needsProject ? setRegion : setGatewayId)(value);
                        clearFeedback();
                      }}
                      style={styles.keyInput}
                      value={needsProject ? region : gatewayId}
                    />
                  </>
                ) : null}
              </>
            ) : null}
            {acceptsKey ? (
              <>
                <Text style={styles.sectionTitle}>
                  {!credential && subscriptionSignIn ? t`Or connect an API key` : t`API key`}
                </Text>
                <TextInput
                  accessibilityLabel={t`API key`}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  editable={!busy}
                  importantForAutofill="no"
                  onChangeText={updateApiKey}
                  placeholder={credential?.hasKey ? t`Paste a replacement key` : t`sk-…`}
                  placeholderTextColor={native.tertiaryLabel}
                  secureTextEntry
                  style={styles.keyInput}
                  textContentType="none"
                  value={apiKey}
                />
              </>
            ) : null}
            {!credential && acceptsKey && modelsForProvider.length ? (
              <MenuPicker
                label={t`Model`}
                choices={modelsForProvider.map((entry) => ({ key: entry.id, label: entry.label }))}
                value={modelId}
                onChange={(id) => {
                  setModelId(id);
                  setThinkingLevel(null);
                }}
                disabled={busy}
                plain
              />
            ) : null}
            {selected.dataRetentionControl ? (
              <SettingsGroup>
                <SettingsSwitch
                  label={t`Zero data retention`}
                  value={zeroDataRetention}
                  disabled={busy}
                  onChange={(value) => {
                    setZeroDataRetention(value);
                    clearFeedback();
                  }}
                />
              </SettingsGroup>
            ) : null}

            <NativeActionButton
              disabled={
                busy ||
                !routingReady ||
                (gatewayOnlySave ? !gatewayDirty : apiKey.trim().length < 8)
              }
              label={
                pending === "connect" && feedbackAnchor === "connection"
                  ? t`Saving…`
                  : gatewayOnlySave
                    ? t`Save`
                    : credential
                      ? t`Replace API key`
                      : t`Connect API key`
              }
              onPress={() => void connectKey()}
              prominence={credential ? "secondary" : "primary"}
              style={{ marginTop: 12 }}
            />
          </View>
        ) : null}
        {selected.auth === "oauth" && !subscriptionSignIn ? (
          <Text style={styles.secondary}>
            {t`This subscription sign-in is not available in Rakazo yet. Use a deployment credential or choose another provider.`}
          </Text>
        ) : null}
      </>
    ) : null;

  const disconnectButton = credential ? (
    <View style={styles.statusRow}>
      <NativeActionButton
        disabled={busy}
        fill={false}
        label={pending === "disconnect" ? t`Disconnecting…` : t`Disconnect`}
        onPress={() => {
          Alert.alert(
            t`Disconnect ${ph({ name: selectedProviderLabel })}?`,
            t`This removes the connection from every space.`,
            [
              { text: t`Cancel`, style: "cancel" },
              {
                text: t`Disconnect`,
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
  const modelList = credential ? (
    <ConnectionModelList
      models={connectionModels(credential, catalog)}
      onOpen={(id) =>
        router.push({
          pathname: "/model-settings",
          params: {
            credentialId: credential.id,
            modelId: id,
            ...(target.scope === "space" ? { spaceId: target.spaceId } : {}),
          },
        })
      }
    />
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
              <NativeActionButton
                disabled={busy || !openAiCompatibleReady}
                label={pending === "connect" ? t`Saving…` : t`Save`}
                onPress={() => void connectKey()}
                style={{ marginTop: 12 }}
              />
              {feedback}
              {modelList}
              {disconnectButton}
            </>
          ) : credential ? (
            <>
              {provider === me?.hostCredentialProvider ? serverCredentialsNote : null}
              {catalogConnectionControls}
              {feedbackAnchor === "connection" ? feedback : null}
              {modelList}
              {disconnectButton}
            </>
          ) : provider === me?.hostCredentialProvider ? (
            <>
              {serverCredentialsNote}
              <DisclosureRow
                label={t`Use your own key`}
                expanded={ownKeyProvider === provider}
                onPress={() =>
                  setOwnKeyProvider((current) => (current === provider ? null : provider))
                }
              />
              {ownKeyProvider === provider ? (
                <>
                  {catalogConnectionControls}
                  {feedback}
                </>
              ) : null}
            </>
          ) : (
            <>
              {catalogConnectionControls}
              {feedback}
            </>
          )
        ) : (
          feedback
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
