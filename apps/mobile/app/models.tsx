import type { ModelOAuthBegin, ThinkingLevel } from "@rakazo/contracts";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  MAX_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_MAX_TOKENS,
  OPENAI_COMPATIBLE_BASE_URL_HINT,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleConnectReady,
  parseModelContextWindow,
  parseModelMaxImagesPerPrompt,
  parseModelMaxTokens,
} from "@rakazo/contracts";
import {
  COMPATIBLE_THINKING_LEVELS,
  clampCatalogThinkingLevel,
  createModelProbe,
  featuredModelProviders,
  filterModelCatalog,
  initialModelProbeState,
  pickCatalogModelId,
} from "@rakazo/core";
import * as Clipboard from "expo-clipboard";
import { useFocusEffect } from "expo-router";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Keyboard,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { type MobileMe, type MobileModel, type MobileModelCredential, rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import {
  cancelModelOAuthAttempt,
  finishModelOAuthAttempt,
  waitForModelOAuth,
} from "../lib/model-auth";
import { native, useResolvedAppearance, useThemedStyles } from "../lib/native";

function connectionMaxTokensField(providerId: string, stored: number | undefined): string {
  if (providerId === OPENAI_COMPATIBLE_PROVIDER_ID) {
    return String(stored ?? DEFAULT_MODEL_MAX_TOKENS);
  }
  return stored !== undefined ? String(stored) : "";
}

const THINKING_LEVEL_OPTIONS: ThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function thinkingLevelLabel(level: ThinkingLevel, t: (message: string) => string): string {
  if (level === "xhigh") return t("Extra high");
  if (level === "low") return t("Low");
  if (level === "medium") return t("Medium");
  if (level === "high") return t("High");
  if (level === "minimal") return t("Minimal");
  if (level === "max") return t("Max");
  return level;
}

/** Providers with more models than this get a search field. */
const MODEL_SEARCH_THRESHOLD = 10;

type ModelSelection = {
  provider?: string;
  modelId?: string;
};

export default function Models() {
  const styles = useThemedStyles(createModelsStyles);
  const { t } = useI18n();
  const colorScheme = useResolvedAppearance();
  const [catalog, setCatalog] = useState<MobileModel[]>([]);
  const [credentials, setCredentials] = useState<MobileModelCredential[]>([]);
  const [me, setMe] = useState<MobileMe | null>(null);
  const [provider, setProvider] = useState("");
  const [showAllProviders, setShowAllProviders] = useState(false);
  const [modelId, setModelId] = useState("");
  const [modelSearch, setModelSearch] = useState({ provider: "", query: "" });
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
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
  const [pending, setPending] = useState<"connect" | "default" | "disconnect" | null>(null);
  const [oauthPending, setOauthPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const oauthAbortRef = useRef<AbortController | null>(null);
  const oauthLoginIdRef = useRef<string | null>(null);
  const oauthCodeSubmittingRef = useRef(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const codeCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        : pickCatalogModelId(
            nextCatalog,
            nextProvider,
            preferred.modelId || nextCredential?.modelId || nextMe.defaultModel,
          );
    setMe(nextMe);
    setCatalog(nextCatalog);
    setCredentials(nextCredentials);
    resetOpenAiCompatibleProbe();
    setProvider(nextProvider);
    setModelSearch((current) =>
      current.provider === nextProvider ? current : { provider: nextProvider, query: "" },
    );
    setModelId(nextModel);
    if (nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID) {
      setBaseUrl(nextCredential?.baseUrl ?? "");
      setReasoning(nextCredential?.reasoning ?? false);
      setThinkingLevel(
        clampCatalogThinkingLevel(
          nextCredential?.modelId === nextModel ? nextCredential?.thinkingLevel : null,
          nextCredential?.reasoning ? COMPATIBLE_THINKING_LEVELS : [],
        ) as ThinkingLevel | null,
      );
      setContextWindow(String(nextCredential?.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW));
      setSupportsImages(nextCredential?.supportsImages ?? false);
      setMaxImagesPerPrompt(String(nextCredential?.maxImagesPerPrompt ?? ""));
    } else {
      // A credential's stored effort is bound to its saved model choice.
      const nextEntry = nextCatalog.find(
        (entry) => entry.provider === nextProvider && entry.id === nextModel,
      );
      setThinkingLevel(
        clampCatalogThinkingLevel(
          nextCredential?.modelId === nextModel ? nextCredential.thinkingLevel : null,
          nextEntry?.thinkingLevels,
        ) as ThinkingLevel | null,
      );
    }
    setMaxTokens(connectionMaxTokensField(nextProvider, nextCredential?.maxTokens));
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load()
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : t("Could not load model settings")),
        )
        .finally(() => setLoading(false));
      return () => {
        modelProbe.invalidate();
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
  const featuredProviders = useMemo(
    () =>
      featuredModelProviders(
        groups.map((group) => group.entries[0]!),
        provider,
      ),
    [groups, provider],
  );
  const connectedProviderIds = useMemo(
    () => new Set(credentials.map((entry) => entry.provider)),
    [credentials],
  );
  const credentialByProvider = useMemo(
    () => new Map(credentials.map((entry) => [entry.provider, entry])),
    [credentials],
  );
  // Connected providers always get their own top section; the rest follow the
  // curated order (featured first, everything behind "Show more").
  const connectedGroups = useMemo(
    () => groups.filter((group) => connectedProviderIds.has(group.id)),
    [groups, connectedProviderIds],
  );
  const otherGroups = useMemo(() => {
    const list = showAllProviders
      ? groups
      : (() => {
          const byId = new Map(groups.map((group) => [group.id, group]));
          return featuredProviders
            .map((entry) => byId.get(entry.provider))
            .filter((group): group is (typeof groups)[number] => group !== undefined);
        })();
    return list.filter((group) => !connectedProviderIds.has(group.id));
  }, [groups, featuredProviders, showAllProviders, connectedProviderIds]);
  const modelsForProvider = catalog.filter((entry) => entry.provider === provider);
  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  const showModelSearch = modelsForProvider.length > MODEL_SEARCH_THRESHOLD;
  // Hide a query typed for another provider until load()/chooseProvider clears it.
  const modelQuery = modelSearch.provider === provider ? modelSearch.query : "";
  const matchedModels = showModelSearch
    ? filterModelCatalog(modelsForProvider, modelQuery)
    : modelsForProvider;
  // Use and Save still apply to the staged model, so its radio stays visible.
  const stagedModelHidden =
    showModelSearch &&
    selected !== undefined &&
    modelQuery.trim().length > 0 &&
    !matchedModels.some((entry) => entry.id === selected.id);
  const visibleModels =
    stagedModelHidden && selected ? [selected, ...matchedModels] : matchedModels;
  const noModelMatches = showModelSearch && matchedModels.length === 0;

  // The search field keeps focus, so tell screen readers once when the results run out.
  useEffect(() => {
    if (noModelMatches) AccessibilityInfo.announceForAccessibility(t("No matching models"));
  }, [noModelMatches, t]);
  const isOpenAiCompatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const credential = credentials.find((entry) => entry.provider === provider);
  const currentEntry = catalog.find(
    (entry) => entry.provider === me?.defaultProvider && entry.id === me?.defaultModel,
  );
  const activeCredential = credentials.find(
    (entry) => entry.provider === me?.defaultProvider && entry.modelId === me?.defaultModel,
  );
  // The banner shows the effective effort — stored level or the runtime
  // default — only when the active model can actually think.
  const activeThinkingLabel =
    (currentEntry?.thinkingLevels ?? []).some((level) => level !== "off") ||
    activeCredential?.reasoning
      ? thinkingLevelLabel(activeCredential?.thinkingLevel ?? "medium", t)
      : null;
  const isActive =
    me?.defaultProvider === selected?.provider &&
    me?.defaultModel === (isOpenAiCompatible ? modelId.trim() : selected?.id);
  const acceptsKey = selected?.auth !== "oauth";
  const subscriptionSignIn = selected?.signIn !== undefined;
  // Effort levels for the staged catalog model — "off" stays out, matching the
  // model settings and per-bot Thinking pickers.
  const catalogThinkingLevels =
    !isOpenAiCompatible && selected
      ? (selected.thinkingLevels ?? []).filter((level) => level !== "off")
      : [];
  const selectedStoredLevel =
    !isOpenAiCompatible && credential?.modelId === selected?.id
      ? (credential?.thinkingLevel ?? null)
      : null;
  const thinkingDirty = !isOpenAiCompatible && (thinkingLevel ?? null) !== selectedStoredLevel;
  const busy = pending !== null || oauthPending;
  const effectiveBaseUrl = baseUrl.trim();
  const openAiCompatibleReady = openAiCompatibleConnectReady({
    baseUrl: effectiveBaseUrl,
    modelId,
  });
  const builtinLimitSave = !isOpenAiCompatible && Boolean(credential) && apiKey.trim().length === 0;

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
    const nextCredential = credentials.find((entry) => entry.provider === nextProvider);
    const nextModelId =
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? (nextCredential?.modelId ?? "")
        : pickCatalogModelId(catalog, nextProvider, nextCredential?.modelId ?? me?.defaultModel);
    Keyboard.dismiss();
    setProvider(nextProvider);
    setModelSearch({ provider: nextProvider, query: "" });
    setReasoning(nextCredential?.reasoning ?? false);
    const nextEntry = catalog.find(
      (entry) => entry.provider === nextProvider && entry.id === nextModelId,
    );
    setThinkingLevel(
      clampCatalogThinkingLevel(
        nextCredential?.modelId === nextModelId ? nextCredential.thinkingLevel : null,
        nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
          ? nextCredential?.reasoning
            ? COMPATIBLE_THINKING_LEVELS
            : []
          : nextEntry?.thinkingLevels,
      ) as ThinkingLevel | null,
    );
    setMaxTokens(connectionMaxTokensField(nextProvider, nextCredential?.maxTokens));
    setContextWindow(String(nextCredential?.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW));
    setSupportsImages(nextCredential?.supportsImages ?? false);
    setMaxImagesPerPrompt(String(nextCredential?.maxImagesPerPrompt ?? ""));
    setModelId(nextModelId);
    setBaseUrl(
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID ? (nextCredential?.baseUrl ?? "") : "",
    );
    setApiKey("");
    resetOpenAiCompatibleProbe();
    setError(null);
    setNotice(null);
  }

  async function probeServerModels() {
    if (!baseUrl.trim()) return;
    setError(null);
    setNotice(null);
    await modelProbe.probe({
      baseUrl,
      apiKey,
      request: (input) => rpc<{ models: string[] }>("models/probeOpenAiCompatible", input),
      onSuccess: (models) => {
        const next = modelId.trim() || models[0] || "";
        if (next !== modelId) stageCompatibleModelId(next);
        else setModelId(next);
        setNotice(
          models.length === 0
            ? t("Server found. Enter a model name.")
            : models.length === 1
              ? t("Found {count} model.", { count: 1 })
              : t("Found {count} models.", { count: models.length }),
        );
      },
      onError: (err) =>
        setError(err instanceof Error ? err.message : t("Could not reach this model server")),
    });
  }

  async function setModelDefault() {
    if (!selected || !credential) return;
    const activeModelId = isOpenAiCompatible ? modelId.trim() : selected.id;
    if (isOpenAiCompatible && !activeModelId) return;
    setError(null);
    setNotice(null);
    setPending("default");
    try {
      await rpc("models/setDefault", {
        provider: selected.provider,
        modelId: activeModelId,
        // Catalog connections keep the space default effort on the preference;
        // openai-compatible still owns its level inside the stored endpoint config.
        ...(!isOpenAiCompatible
          ? {
              thinkingLevel: clampCatalogThinkingLevel(
                thinkingLevel,
                selected.thinkingLevels,
              ) as ThinkingLevel | null,
            }
          : {}),
      });
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

  async function disconnectCredential() {
    if (!selected || !credential) return;
    cancelOAuth();
    setError(null);
    setNotice(null);
    setPending("disconnect");
    try {
      await rpc("models/disconnect", { provider: selected.provider });
      setApiKey("");
      setThinkingLevel(null);
      await load({ provider });
      setNotice(
        t("Disconnected {provider}.", { provider: selected.providerName ?? selected.provider }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not disconnect this provider"));
    } finally {
      setPending(null);
    }
  }

  function stageCompatibleModelId(nextModelId: string) {
    setModelId(nextModelId);
    setThinkingLevel(
      clampCatalogThinkingLevel(
        credential?.modelId === nextModelId ? credential.thinkingLevel : null,
        reasoning ? COMPATIBLE_THINKING_LEVELS : [],
      ) as ThinkingLevel | null,
    );
  }

  async function connectKey() {
    if (!selected) return;
    const savingLimitOnly = !isOpenAiCompatible && !apiKey.trim();
    const activeModelId = isOpenAiCompatible ? modelId.trim() : selected.id;
    const supportedThinking = isOpenAiCompatible
      ? reasoning
        ? COMPATIBLE_THINKING_LEVELS
        : []
      : selected.thinkingLevels;
    const stagedThinking = clampCatalogThinkingLevel(
      thinkingLevel,
      supportedThinking,
    ) as ThinkingLevel | null;
    const modelChanged = (credential?.modelId ?? null) !== (activeModelId || null);
    if (isOpenAiCompatible) {
      if (!effectiveBaseUrl || !modelId.trim()) return;
    } else if (savingLimitOnly) {
      if (!credential) return;
    } else if (apiKey.trim().length < 8) {
      return;
    }
    const parsedMaxTokens = maxTokens.trim() ? parseModelMaxTokens(maxTokens) : undefined;
    if ((isOpenAiCompatible || maxTokens.trim()) && parsedMaxTokens === undefined) {
      setError(
        t("Enter a whole number from 1 to {max} for maximum output tokens.", {
          max: MAX_MODEL_MAX_TOKENS,
        }),
      );
      return;
    }
    const parsedMaxImagesPerPrompt = isOpenAiCompatible
      ? parseModelMaxImagesPerPrompt(maxImagesPerPrompt, supportsImages)
      : undefined;
    if (
      isOpenAiCompatible &&
      supportsImages &&
      maxImagesPerPrompt.trim() &&
      parsedMaxImagesPerPrompt === undefined
    ) {
      setError(t("Enter a whole number from 1 to 1000 for the image limit."));
      return;
    }
    const maxImagesPerPromptInput =
      supportsImages && !maxImagesPerPrompt.trim() ? null : parsedMaxImagesPerPrompt;
    const parsedContextWindow = isOpenAiCompatible
      ? parseModelContextWindow(contextWindow)
      : undefined;
    if (isOpenAiCompatible && parsedContextWindow === undefined) {
      setError(
        t("Enter a whole number from 1 to {max} for the context limit.", {
          max: MAX_MODEL_CONTEXT_WINDOW,
        }),
      );
      return;
    }
    if (isOpenAiCompatible && parsedMaxTokens === undefined) return;
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
              reasoning,
              thinkingLevel: stagedThinking,
              maxTokens: parsedMaxTokens,
              contextWindow: parsedContextWindow,
              supportsImages,
              maxImagesPerPrompt: maxImagesPerPromptInput,
              apiKey: apiKey.trim() || undefined,
              label: selected.providerName ?? selected.provider,
            }
          : {
              provider: selected.provider,
              ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
              modelId: selected.id,
              // A limits-only save leaves the stored effort alone while the model
              // stays put. Changing the model sends the clamped level, including
              // null, so the previous model's effort is not reused.
              ...(!savingLimitOnly || modelChanged ? { thinkingLevel: stagedThinking } : {}),
              maxTokens: parsedMaxTokens ?? null,
              label: selected.providerName ?? selected.provider,
            },
      );
      setApiKey("");
      await load({ provider, modelId });
      setNotice(
        isOpenAiCompatible || savingLimitOnly
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
          thinkingLevel: clampCatalogThinkingLevel(
            thinkingLevel,
            selected.thinkingLevels,
          ) as ThinkingLevel | null,
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
        <Text style={styles.outlineLabel}>{probing ? t("Finding…") : t("Find models")}</Text>
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
              onPress={() => stageCompatibleModelId(entry)}
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
            onPress={() => stageCompatibleModelId("")}
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
            >
              <Text style={styles.helpLabel}>{t("Use a found model")}</Text>
            </Pressable>
          ) : null}
        </>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: showAdvanced }}
        onPress={() => setShowAdvanced((visible) => !visible)}
      >
        <Text style={styles.helpLabel}>{t("Advanced")}</Text>
      </Pressable>
      {showAdvanced ? (
        <View style={styles.modelRow}>
          <Text style={styles.modelLabel}>{t("Supports thinking")}</Text>
          <Switch
            accessibilityLabel={t("Supports thinking")}
            value={reasoning}
            onValueChange={(value) => {
              setReasoning(value);
              if (!value) setThinkingLevel(null);
            }}
            disabled={busy}
          />
        </View>
      ) : null}
      {showAdvanced && reasoning ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Reasoning effort")}
          disabled={busy}
          onPress={() => {
            presentMessageActionSheet({
              title: t("Reasoning effort"),
              cancel: t("Cancel"),
              more: t("More"),
              colorScheme,
              actions: [
                {
                  text: t("Default"),
                  onPress: () => setThinkingLevel(null),
                },
                ...THINKING_LEVEL_OPTIONS.map((level) => ({
                  text: thinkingLevelLabel(level, t),
                  onPress: () => setThinkingLevel(level),
                })),
              ],
            });
          }}
          style={styles.modelRow}
        >
          <Text style={styles.modelLabel}>{t("Reasoning effort")}</Text>
          <Text style={styles.helpLabel}>
            {thinkingLevel ? thinkingLevelLabel(thinkingLevel, t) : t("Default")}
          </Text>
        </Pressable>
      ) : null}
      {showAdvanced ? (
        <View style={styles.modelRow}>
          <Text style={styles.modelLabel}>{t("Context limit")}</Text>
          <TextInput
            accessibilityLabel={t("Context limit")}
            editable={!busy}
            keyboardType="number-pad"
            maxLength={7}
            onChangeText={setContextWindow}
            style={[styles.keyInput, styles.maxImagesInput]}
            value={contextWindow}
          />
        </View>
      ) : null}
      {showAdvanced ? (
        <View style={styles.modelRow}>
          <Text style={styles.modelLabel}>{t("Maximum output tokens")}</Text>
          <TextInput
            accessibilityLabel={t("Maximum output tokens")}
            editable={!busy}
            keyboardType="number-pad"
            maxLength={6}
            onChangeText={setMaxTokens}
            style={[styles.keyInput, styles.maxImagesInput]}
            value={maxTokens}
          />
        </View>
      ) : null}
      {showAdvanced ? (
        <View style={styles.modelRow}>
          <Text style={styles.modelLabel}>{t("Supports images")}</Text>
          <Switch
            accessibilityLabel={t("Supports images")}
            value={supportsImages}
            onValueChange={setSupportsImages}
            disabled={busy}
          />
        </View>
      ) : null}
      {showAdvanced && supportsImages ? (
        <View style={styles.modelRow}>
          <Text style={styles.modelLabel}>{t("Maximum images per request")}</Text>
          <TextInput
            accessibilityLabel={t("Maximum images per request")}
            editable={!busy}
            keyboardType="number-pad"
            maxLength={4}
            onChangeText={setMaxImagesPerPrompt}
            style={[styles.keyInput, styles.maxImagesInput]}
            value={maxImagesPerPrompt}
          />
        </View>
      ) : null}
    </>
  ) : null;

  const compatKeySection =
    isOpenAiCompatible && acceptsKey ? (
      <View style={styles.keySection}>
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

        <Pressable
          accessibilityRole="button"
          disabled={
            busy || (isOpenAiCompatible ? !openAiCompatibleReady : apiKey.trim().length < 8)
          }
          onPress={() => void connectKey()}
          style={({ pressed }) => [
            styles.primaryButton,
            (busy || (isOpenAiCompatible ? !openAiCompatibleReady : apiKey.trim().length < 8)) &&
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
    ) : null;

  const catalogModelCard =
    !isOpenAiCompatible && selected ? (
      <>
        {showModelSearch ? (
          <TextInput
            accessibilityLabel={t("Search models")}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={(query) => setModelSearch({ provider, query })}
            placeholder={t("Search")}
            placeholderTextColor={native.tertiaryLabel}
            returnKeyType="search"
            style={styles.keyInput}
            value={modelQuery}
          />
        ) : null}
        <View style={styles.card}>
          {visibleModels.map((entry, index) => (
            <Fragment key={`${entry.provider}:${entry.id}`}>
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: entry.id === selected.id }}
                onPress={() => {
                  Keyboard.dismiss();
                  cancelOAuth();
                  setModelId(entry.id);
                  setThinkingLevel(
                    clampCatalogThinkingLevel(
                      entry.id === credential?.modelId ? credential?.thinkingLevel : null,
                      entry.thinkingLevels,
                    ) as ThinkingLevel | null,
                  );
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
              {stagedModelHidden && noModelMatches && index === 0 ? (
                <View style={styles.modelRow}>
                  <Text style={[styles.modelLabel, styles.mutedLabel]}>
                    {t("No matching models")}
                  </Text>
                </View>
              ) : null}
            </Fragment>
          ))}
          {!stagedModelHidden && noModelMatches ? (
            <View style={styles.modelRow}>
              <Text style={[styles.modelLabel, styles.mutedLabel]}>{t("No matching models")}</Text>
            </View>
          ) : null}
        </View>
        {catalogThinkingLevels.length ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Thinking")}
            disabled={busy}
            onPress={() => {
              presentMessageActionSheet({
                title: t("Thinking"),
                cancel: t("Cancel"),
                more: t("More"),
                colorScheme,
                actions: [
                  {
                    text: t("Default ({level})", {
                      level: thinkingLevelLabel("medium", t),
                    }),
                    onPress: () => {
                      setThinkingLevel(null);
                      setNotice(null);
                    },
                  },
                  ...catalogThinkingLevels.map((level) => ({
                    text: thinkingLevelLabel(level, t),
                    onPress: () => {
                      setThinkingLevel(level);
                      setNotice(null);
                    },
                  })),
                ],
              });
            }}
            style={styles.modelRow}
          >
            <Text style={styles.modelLabel}>{t("Thinking")}</Text>
            <Text style={styles.helpLabel}>
              {thinkingLevel
                ? thinkingLevelLabel(thinkingLevel, t)
                : t("Default ({level})", { level: thinkingLevelLabel("medium", t) })}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: showAdvanced }}
          onPress={() => setShowAdvanced((visible) => !visible)}
        >
          <Text style={styles.helpLabel}>{t("Advanced")}</Text>
        </Pressable>
        {showAdvanced ? (
          <View style={styles.modelRow}>
            <Text style={styles.modelLabel}>{t("Maximum output tokens")}</Text>
            <TextInput
              accessibilityLabel={t("Maximum output tokens")}
              editable={!busy}
              keyboardType="number-pad"
              maxLength={6}
              onChangeText={setMaxTokens}
              style={[styles.keyInput, styles.maxImagesInput]}
              value={maxTokens}
            />
          </View>
        ) : null}
        {!isOpenAiCompatible && selected.billing ? (
          <Text style={styles.billing}>{selected.billing}</Text>
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
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => copyOAuthCode(oauth.userCode)}
                    style={({ pressed }) => [styles.outlineButton, pressed && styles.pressed]}
                  >
                    <Text style={styles.outlineLabel}>{codeCopied ? t("Copied") : t("Copy")}</Text>
                  </Pressable>
                  <Text style={styles.secondary}>
                    {t("Waiting for sign-in — the code expires in about {minutes} minutes.", {
                      minutes: Math.ceil(oauth.expiresInSeconds / 60),
                    })}
                  </Text>
                </>
              )}
              <Pressable
                accessibilityRole="button"
                onPress={() => cancelOAuth()}
                style={({ pressed }) => [styles.outlineButton, pressed && styles.pressed]}
              >
                <Text style={styles.outlineLabel}>{t("Cancel")}</Text>
              </Pressable>
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
                {oauthPending
                  ? t("Starting…")
                  : credential
                    ? t("Sign in again")
                    : (selected.oauthLabel ?? t("Sign in"))}
              </Text>
            </Pressable>
          )
        ) : null}
        {acceptsKey || builtinLimitSave ? (
          <View style={styles.keySection}>
            {acceptsKey ? (
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
            ) : null}

            <Pressable
              accessibilityRole="button"
              disabled={busy || (!builtinLimitSave && apiKey.trim().length < 8)}
              onPress={() => void connectKey()}
              style={({ pressed }) => [
                styles.primaryButton,
                (busy || (!builtinLimitSave && apiKey.trim().length < 8)) && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.primaryLabel}>
                {pending === "connect"
                  ? t("Saving…")
                  : builtinLimitSave
                    ? t("Save limits")
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
      </>
    ) : null;

  const saveRow =
    credential && (!isActive || thinkingDirty) ? (
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
          {pending === "default" ? t("Switching…") : isActive ? t("Save") : t("Use this model")}
        </Text>
      </Pressable>
    ) : null;

  const connectedStatusRow = credential ? (
    <View style={styles.statusRow}>
      <View style={styles.providerCopy}>
        <Text style={styles.providerName}>
          {t("Connected · {label}", { label: credential.label })}
        </Text>
        <Text style={styles.secondary}>{t("Stored securely. Never shown here.")}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() => {
          const name = selected?.providerName ?? selected?.provider ?? "";
          Alert.alert(
            t("Disconnect {name}?", { name }),
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
        style={({ pressed }) => [pressed && styles.pressed, busy && styles.disabled]}
      >
        <Text style={styles.disconnectLabel}>
          {pending === "disconnect" ? t("Disconnecting…") : t("Disconnect")}
        </Text>
      </Pressable>
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
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.activeCard}>
          <Text style={styles.eyebrow}>{t("Active model")}</Text>
          <Text style={styles.activeModel}>
            {currentEntry?.label ?? me?.defaultModel ?? t("Deployment default")}
          </Text>
          <Text style={styles.secondary}>
            {currentEntry?.providerName ?? me?.defaultProvider ?? t("Configured by deployment")}
            {activeThinkingLabel
              ? ` · ${t("Thinking: {level}", { level: activeThinkingLabel })}`
              : ""}
          </Text>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}

        <Text style={styles.sectionTitle}>{t("Providers")}</Text>
        <View style={styles.card}>
          {connectedGroups.length ? (
            <>
              <Text style={styles.groupLabel}>{t("Connected")}</Text>
              {connectedGroups.map((group) => {
                const groupCredential = credentialByProvider.get(group.id);
                const savedModelLabel = groupCredential?.modelId
                  ? (group.entries.find((entry) => entry.id === groupCredential.modelId)?.label ??
                    groupCredential.modelId)
                  : null;
                return (
                  <Pressable
                    key={group.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: group.id === provider }}
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
                        {savedModelLabel ??
                          t(group.entries.length === 1 ? "{count} model" : "{count} models", {
                            count: group.entries.length,
                          })}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
              {otherGroups.length ? (
                <Text style={styles.groupLabel}>{t("All providers")}</Text>
              ) : null}
            </>
          ) : null}
          {otherGroups.map((group) => (
            <Pressable
              key={group.id}
              accessibilityRole="button"
              accessibilityState={{ selected: group.id === provider }}
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
            </Pressable>
          ))}
          {groups.length > featuredProviders.length ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: showAllProviders }}
              onPress={() => setShowAllProviders((value) => !value)}
              style={styles.providerRow}
            >
              <Text style={styles.providerName}>
                {showAllProviders ? t("Show less") : t("Show more")}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {selected ? (
          isOpenAiCompatible ? (
            <>
              {compatConfig}
              {compatKeySection}
              {saveRow}
            </>
          ) : credential ? (
            <>
              {connectedStatusRow}
              <Text style={styles.sectionTitle}>{t("Model")}</Text>
              {catalogModelCard}
              {saveRow}
              <View style={styles.maintenanceSection}>{catalogConnectionControls}</View>
            </>
          ) : (
            <>
              <Text style={styles.secondary}>
                {t("Connect this provider to use it as your personal model.")}
              </Text>
              {catalogConnectionControls}
              <Text style={styles.sectionTitle}>{t("Model")}</Text>
              {catalogModelCard}
            </>
          )
        ) : null}
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
    groupLabel: {
      color: native.tertiaryLabel,
      fontSize: 12,
      textTransform: "uppercase",
      letterSpacing: 1,
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 8,
    },
    statusRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      marginTop: 8,
    },
    disconnectLabel: {
      color: native.secondaryLabel,
      fontSize: 15,
    },
    maintenanceSection: {
      marginTop: 16,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: native.fillPressed,
      paddingTop: 8,
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
    mutedLabel: {
      color: native.secondaryLabel,
    },
    selectedRow: {
      backgroundColor: tokens.accent,
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
      minHeight: 48,
      borderRadius: 12,
      backgroundColor: native.fill,
      color: native.label,
      paddingHorizontal: 14,
      paddingVertical: 10,
      marginTop: 4,
      fontSize: 16,
    },
    maxImagesInput: {
      width: 72,
      minHeight: 40,
      paddingVertical: 8,
      marginTop: 0,
      textAlign: "center",
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
      color: tokens.destructive,
      fontSize: 14,
      marginTop: 4,
    },
    notice: {
      color: tokens.success,
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
