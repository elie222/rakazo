import type { ModelBackupChoice, ModelOAuthBegin, ThinkingLevel } from "@rakazo/contracts";
import {
  backupChoiceKey,
  CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
  cloudflareGatewayRouting,
  connectedBackupOptions,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  MAX_MODEL_BACKUPS,
  MAX_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_MAX_TOKENS,
  moveBackupChoice,
  OPENAI_COMPATIBLE_BASE_URL_HINT,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleConnectReady,
  parseModelContextWindow,
  parseModelMaxImagesPerPrompt,
  parseModelMaxTokens,
  sameBackupChoices,
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
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSwitch } from "../../components/native-switch";
import { Checkmark, Chevron } from "../../components/row-accessories";
import type {
  ApiRequestContext,
  MobileMe,
  MobileModel,
  MobileModelCredential,
} from "../../lib/api";
import { captureApiRequestContext, rpc, selectedSpaceId } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { presentMessageActionSheet } from "../../lib/message-action-sheet";
import {
  cancelModelOAuthAttempt,
  finishModelOAuthAttempt,
  waitForModelOAuth,
} from "../../lib/model-auth";
import { mobileBackupScopeIsCurrent } from "../../lib/model-backups";
import { native, useResolvedAppearance, useThemedStyles } from "../../lib/native";
import { errorText } from "../../lib/user-error";

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

type FeedbackAnchor = "probe" | "model" | "connection";

export default function Models() {
  const styles = useThemedStyles(createModelsStyles);
  const { t } = useI18n();
  const colorScheme = useResolvedAppearance();
  const [catalog, setCatalog] = useState<MobileModel[]>([]);
  const [credentials, setCredentials] = useState<MobileModelCredential[]>([]);
  const [me, setMe] = useState<MobileMe | null>(null);
  const [provider, setProvider] = useState("");
  // The provider whose optional personal-key form is open.
  const [ownKeyProvider, setOwnKeyProvider] = useState<string | null>(null);
  const [showAllProviders, setShowAllProviders] = useState(false);
  const [modelId, setModelId] = useState("");
  const [modelSearch, setModelSearch] = useState({ provider: "", query: "" });
  const [apiKey, setApiKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [gatewayId, setGatewayId] = useState("");
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
  const [backupModels, setBackupModels] = useState<ModelBackupChoice[]>([]);
  const [savedBackupModels, setSavedBackupModels] = useState<ModelBackupChoice[]>([]);
  const [backupLoading, setBackupLoading] = useState(true);
  const [backupReady, setBackupReady] = useState(false);
  const [backupSaving, setBackupSaving] = useState(false);
  const backupReadyRef = useRef(false);
  const backupLoadingRef = useRef(true);
  const backupSavingRef = useRef(false);
  backupReadyRef.current = backupReady;
  backupLoadingRef.current = backupLoading;
  backupSavingRef.current = backupSaving;
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupNotice, setBackupNotice] = useState<string | null>(null);
  const backupRequestGenerationRef = useRef(0);
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
    const message = nextError ?? next.notice ?? null;
    // VoiceOver keeps focus on the tapped button, so speak the result from here.
    // Success is spoken only: the selection already shows the active model.
    if (message) AccessibilityInfo.announceForAccessibility(message);
  }

  function clearFeedback() {
    setFeedbackAnchor("connection");
    setError(null);
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
    meRef.current = nextMe;
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
    setAccountId(nextCredential?.accountId ?? "");
    setGatewayId(nextCredential?.gatewayId ?? "");
    return nextMe;
  }, []);

  const loadBackupModels = useCallback(
    async (expectedMe: MobileMe) => {
      const requestGeneration = ++backupRequestGenerationRef.current;
      const expected = { userId: expectedMe.userId, spaceId: expectedMe.spaceId };
      backupReadyRef.current = false;
      backupLoadingRef.current = true;
      setBackupReady(false);
      setBackupLoading(true);
      setBackupModels([]);
      setSavedBackupModels([]);
      setBackupError(null);
      setBackupNotice(null);
      try {
        const requestContext: ApiRequestContext = await captureApiRequestContext();
        const currentMe = await rpc<MobileMe>("me", {}, { requestContext });
        if (
          !mobileBackupScopeIsCurrent({
            expectedUserId: expected.userId,
            expectedSpaceId: expected.spaceId,
            currentUserId: currentMe.userId,
            currentSpaceId: currentMe.spaceId,
            selectedSpaceId: selectedSpaceId(),
            requestGeneration,
            currentGeneration: backupRequestGenerationRef.current,
          })
        ) {
          throw new Error(t("Space changed. Reload Models to refresh backup models."));
        }
        const saved = await rpc<ModelBackupChoice[]>("models/backups", {}, { requestContext });
        const liveMe = meRef.current;
        if (
          requestGeneration !== backupRequestGenerationRef.current ||
          !liveMe ||
          !mobileBackupScopeIsCurrent({
            expectedUserId: expected.userId,
            expectedSpaceId: expected.spaceId,
            currentUserId: liveMe.userId,
            currentSpaceId: liveMe.spaceId,
            selectedSpaceId: selectedSpaceId(),
            requestGeneration,
            currentGeneration: backupRequestGenerationRef.current,
          })
        ) {
          return;
        }
        setSavedBackupModels([...saved]);
        setBackupModels([...saved]);
        backupReadyRef.current = true;
        setBackupReady(true);
      } catch (err) {
        if (requestGeneration !== backupRequestGenerationRef.current) return;
        backupReadyRef.current = false;
        setBackupReady(false);
        setBackupError(err instanceof Error ? err.message : t("Could not load backup models"));
      } finally {
        if (requestGeneration === backupRequestGenerationRef.current) {
          backupLoadingRef.current = false;
          setBackupLoading(false);
        }
      }
    },
    [t],
  );

  useFocusEffect(
    useCallback(() => {
      void load()
        .then((nextMe) => loadBackupModels(nextMe))
        .catch((err: unknown) =>
          publishFeedback("connection", {
            error: errorText(err, t("Could not load model settings")),
          }),
        )
        .finally(() => setLoading(false));
      return () => {
        backupRequestGenerationRef.current += 1;
        backupReadyRef.current = false;
        backupLoadingRef.current = true;
        backupSavingRef.current = false;
        setBackupModels([]);
        setSavedBackupModels([]);
        setBackupReady(false);
        setBackupLoading(true);
        setBackupSaving(false);
        setBackupError(null);
        setBackupNotice(null);
        modelProbe.invalidate();
        cancelOAuth();
      };
    }, [cancelOAuth, load, loadBackupModels]),
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
  const backupOptions = useMemo(
    () => connectedBackupOptions(catalog, credentials),
    [catalog, credentials],
  );
  const backupOptionByKey = useMemo(
    () => new Map(backupOptions.map((option) => [backupChoiceKey(option), option])),
    [backupOptions],
  );
  const currentBackupKeys = new Set(backupModels.map(backupChoiceKey));
  const addableBackupOptions = backupOptions.filter(
    (option) => !currentBackupKeys.has(backupChoiceKey(option)),
  );
  const backupDirty = !sameBackupChoices(savedBackupModels, backupModels);
  const backupLocked = !backupReady || backupLoading || backupSaving;
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
  const isCloudflareGateway = provider === CLOUDFLARE_AI_GATEWAY_PROVIDER_ID;
  const cloudflareRoutingReady =
    !isCloudflareGateway || cloudflareGatewayRouting({ accountId, gatewayId }) !== undefined;
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
  // Space still bills the host while this provider matches; model id alone is not credentials.
  const usingServerCredentials = provider === me?.hostCredentialProvider;
  const acceptsKey = selected?.auth !== "oauth";
  const subscriptionSignIn = selected?.signIn !== undefined;
  // Effort levels for the staged catalog model — "off" stays out, matching the
  // model settings and per-bot Thinking pickers.
  const catalogThinkingLevels =
    !isOpenAiCompatible && selected
      ? (selected.thinkingLevels ?? []).filter((level) => level !== "off")
      : [];
  const reasoningEffortValue = thinkingLevel ? thinkingLevelLabel(thinkingLevel, t) : t("Default");
  const catalogThinkingValue = thinkingLevel
    ? thinkingLevelLabel(thinkingLevel, t)
    : t("Default ({level})", { level: thinkingLevelLabel("medium", t) });
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
    clearFeedback();
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
    setAccountId(nextCredential?.accountId ?? "");
    setGatewayId(nextCredential?.gatewayId ?? "");
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
      request: (input) => rpc<{ models: string[] }>("models/probeOpenAiCompatible", input),
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

  async function setModelDefault() {
    if (!selected || !credential) return;
    const activeModelId = isOpenAiCompatible ? modelId.trim() : selected.id;
    if (isOpenAiCompatible && !activeModelId) return;
    Keyboard.dismiss();
    clearFeedback();
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
      publishFeedback("model", {
        notice: isOpenAiCompatible
          ? t("Model updated.")
          : t("Now using {label}.", { label: selected.label }),
      });
    } catch (err) {
      publishFeedback("model", {
        error: errorText(err, t("Could not change the default model")),
      });
    } finally {
      setPending(null);
    }
  }

  async function disconnectCredential() {
    if (!selected || !credential) return;
    cancelOAuth();
    clearFeedback();
    setPending("disconnect");
    try {
      await rpc("models/disconnect", { provider: selected.provider });
      setApiKey("");
      setThinkingLevel(null);
      await load({ provider });
      publishFeedback("connection", {
        notice: t("Disconnected {provider}.", {
          provider: selected.providerName ?? selected.provider,
        }),
      });
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
    // Drop the previous result before the limit check so it cannot sit beside the new one.
    Keyboard.dismiss();
    clearFeedback();
    const parsedMaxTokens = maxTokens.trim() ? parseModelMaxTokens(maxTokens) : undefined;
    if ((isOpenAiCompatible || maxTokens.trim()) && parsedMaxTokens === undefined) {
      publishFeedback("connection", {
        error: t("Enter a whole number from 1 to {max} for maximum output tokens.", {
          max: MAX_MODEL_MAX_TOKENS,
        }),
      });
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
      publishFeedback("connection", {
        error: t("Enter a whole number from 1 to 1000 for the image limit."),
      });
      return;
    }
    const maxImagesPerPromptInput =
      supportsImages && !maxImagesPerPrompt.trim() ? null : parsedMaxImagesPerPrompt;
    const parsedContextWindow = isOpenAiCompatible
      ? parseModelContextWindow(contextWindow)
      : undefined;
    if (isOpenAiCompatible && parsedContextWindow === undefined) {
      publishFeedback("connection", {
        error: t("Enter a whole number from 1 to {max} for the context limit.", {
          max: MAX_MODEL_CONTEXT_WINDOW,
        }),
      });
      return;
    }
    if (isOpenAiCompatible && parsedMaxTokens === undefined) return;
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
              ...(provider === CLOUDFLARE_AI_GATEWAY_PROVIDER_ID
                ? { accountId: accountId.trim(), gatewayId: gatewayId.trim() }
                : {}),
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
      publishFeedback("connection", {
        notice:
          isOpenAiCompatible || savingLimitOnly
            ? t("Saved.")
            : t("Connected and using {label}.", { label: selected.label }),
      });
    } catch (err) {
      publishFeedback("connection", {
        error: errorText(err, t("Could not connect this provider")),
      });
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
    publishFeedback("connection", {
      notice: t("Connected and using {label}.", { label: selected?.label ?? t("this model") }),
    });
  }

  async function startSubscriptionSignIn() {
    if (!selected) return;
    clearFeedback();
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

  const feedback = error ? <Text style={styles.error}>{error}</Text> : null;

  function disclosureRow(label: string, expanded: boolean, onPress: () => void) {
    return (
      <View style={styles.card}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={onPress}
          style={({ pressed }) => [styles.modelRow, styles.singleRow, pressed && styles.pressed]}
        >
          <Text style={styles.modelLabel}>{label}</Text>
          <View style={styles.chevron}>
            <Chevron expanded={expanded} />
          </View>
        </Pressable>
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
        style={({ pressed }) => [pressed && styles.pressed]}
      >
        <Text style={styles.textAction}>{t("Setup help")}</Text>
      </Pressable>
      {showEndpointHelp ? (
        <Text style={styles.hint}>{t(OPENAI_COMPATIBLE_BASE_URL_HINT)}</Text>
      ) : null}
      <NativeActionButton
        disabled={busy || probing || !effectiveBaseUrl}
        fill
        label={probing ? t("Finding…") : t("Find models")}
        onPress={() => void probeServerModels()}
        prominence="secondary"
        style={{ marginTop: 12 }}
      />
      {feedbackAnchor === "probe" ? feedback : null}
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
                probing && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.modelLabel}>{entry}</Text>
              {entry === modelId ? <Checkmark /> : null}
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
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Reasoning effort")}
                accessibilityValue={{ text: reasoningEffortValue }}
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
                style={({ pressed }) => [styles.modelRow, pressed && styles.pressed]}
              >
                <Text style={styles.modelLabel}>{t("Reasoning effort")}</Text>
                <Text style={styles.rowValue}>{reasoningEffortValue}</Text>
              </Pressable>
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
          {limitField(t("Context limit"), contextWindow, setContextWindow, 7)}
          {limitField(t("Maximum output tokens"), maxTokens, setMaxTokens, 6)}
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
        {disclosureRow(t("API key"), showApiKey, () => setShowApiKey((visible) => !visible))}
        {showApiKey ? (
          <TextInput
            accessibilityLabel={t("API key")}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            editable={!busy}
            importantForAutofill="no"
            onChangeText={updateApiKey}
            placeholder={credential?.hasKey ? t("Paste a replacement key") : t("Optional")}
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
                  clearFeedback();
                }}
                style={({ pressed }) => [styles.modelRow, pressed && styles.pressed]}
              >
                <Text style={styles.modelLabel}>{entry.label}</Text>
                {entry.id === selected.id ? <Checkmark /> : null}
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
          {catalogThinkingLevels.length ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Thinking")}
              accessibilityValue={{ text: catalogThinkingValue }}
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
                      onPress: () => setThinkingLevel(null),
                    },
                    ...catalogThinkingLevels.map((level) => ({
                      text: thinkingLevelLabel(level, t),
                      onPress: () => setThinkingLevel(level),
                    })),
                  ],
                });
              }}
              style={({ pressed }) => [
                styles.modelRow,
                styles.singleRow,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.modelLabel}>{t("Thinking")}</Text>
              <Text style={styles.rowValue}>{catalogThinkingValue}</Text>
            </Pressable>
          ) : null}
        </View>
        {disclosureRow(t("Advanced"), showAdvanced, () => setShowAdvanced((visible) => !visible))}
        {showAdvanced ? limitField(t("Maximum output tokens"), maxTokens, setMaxTokens, 6) : null}
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
        {acceptsKey || builtinLimitSave ? (
          <View style={styles.keySection}>
            {isCloudflareGateway ? (
              <>
                <Text style={styles.sectionTitle}>{t("Account ID")}</Text>
                <TextInput
                  accessibilityLabel={t("Account ID")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  editable={!busy}
                  onChangeText={setAccountId}
                  style={styles.keyInput}
                  value={accountId}
                />
                <Text style={styles.sectionTitle}>{t("Gateway ID")}</Text>
                <TextInput
                  accessibilityLabel={t("Gateway ID")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  editable={!busy}
                  onChangeText={setGatewayId}
                  style={styles.keyInput}
                  value={gatewayId}
                />
              </>
            ) : null}
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
                busy || !cloudflareRoutingReady || (!builtinLimitSave && apiKey.trim().length < 8)
              }
              label={
                pending === "connect"
                  ? t("Saving…")
                  : builtinLimitSave
                    ? t("Save limits")
                    : credential
                      ? t("Replace API key")
                      : t("Connect API key")
              }
              onPress={() => void connectKey()}
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

  function addBackupChoice(choice: ModelBackupChoice) {
    if (backupLoadingRef.current || !backupReadyRef.current || backupSavingRef.current) return;
    setBackupModels((current) => {
      if (
        backupLoadingRef.current ||
        !backupReadyRef.current ||
        backupSavingRef.current ||
        current.length >= MAX_MODEL_BACKUPS ||
        current.some((entry) => backupChoiceKey(entry) === backupChoiceKey(choice))
      ) {
        return current;
      }
      return [...current, { provider: choice.provider, modelId: choice.modelId }];
    });
    setBackupError(null);
    setBackupNotice(null);
  }

  function openBackupModelPicker() {
    if (
      backupLoadingRef.current ||
      !backupReadyRef.current ||
      backupSavingRef.current ||
      backupModels.length >= MAX_MODEL_BACKUPS
    )
      return;
    presentMessageActionSheet({
      title: t("Add connected model"),
      actions: addableBackupOptions.map((option) => ({
        text: `${option.providerName} · ${option.label}`,
        onPress: () => addBackupChoice({ provider: option.provider, modelId: option.modelId }),
      })),
      colorScheme,
      cancel: t("Cancel"),
      more: t("More"),
    });
  }

  function backupRowLabel(choice: ModelBackupChoice) {
    const option = backupOptionByKey.get(backupChoiceKey(choice));
    const entry = catalog.find(
      (candidate) => candidate.provider === choice.provider && candidate.id === choice.modelId,
    );
    const providerName = option?.providerName ?? entry?.providerName ?? choice.provider;
    const label = option?.label ?? entry?.label ?? choice.modelId;
    return { label: `${providerName} · ${label}`, connected: Boolean(option) };
  }

  async function saveBackupModels() {
    if (
      !me ||
      !backupDirty ||
      backupLoadingRef.current ||
      !backupReadyRef.current ||
      backupSavingRef.current
    )
      return;
    const expected = { userId: me.userId, spaceId: me.spaceId };
    const requestGeneration = backupRequestGenerationRef.current;
    const choices = backupModels.map((choice) => ({ ...choice }));
    backupSavingRef.current = true;
    setBackupSaving(true);
    setBackupError(null);
    setBackupNotice(null);
    try {
      const requestContext: ApiRequestContext = await captureApiRequestContext();
      const currentMe = await rpc<MobileMe>("me", {}, { requestContext });
      if (
        !mobileBackupScopeIsCurrent({
          expectedUserId: expected.userId,
          expectedSpaceId: expected.spaceId,
          currentUserId: currentMe.userId,
          currentSpaceId: currentMe.spaceId,
          selectedSpaceId: selectedSpaceId(),
          requestGeneration,
          currentGeneration: backupRequestGenerationRef.current,
        })
      ) {
        throw new Error(t("Space changed. Reload Models before saving backups."));
      }
      await rpc("models/setBackups", choices, { requestContext });
      const liveMe = meRef.current;
      if (
        !liveMe ||
        !mobileBackupScopeIsCurrent({
          expectedUserId: expected.userId,
          expectedSpaceId: expected.spaceId,
          currentUserId: liveMe.userId,
          currentSpaceId: liveMe.spaceId,
          selectedSpaceId: selectedSpaceId(),
          requestGeneration,
          currentGeneration: backupRequestGenerationRef.current,
        })
      ) {
        return;
      }
      setSavedBackupModels(choices);
      setBackupNotice(t("Backup models saved."));
    } catch (err) {
      if (requestGeneration !== backupRequestGenerationRef.current) return;
      setBackupError(err instanceof Error ? err.message : t("Could not save backup models"));
    } finally {
      if (requestGeneration === backupRequestGenerationRef.current) {
        backupSavingRef.current = false;
        setBackupSaving(false);
      }
    }
  }

  const saveRow =
    credential && (!isActive || thinkingDirty || usingServerCredentials) ? (
      <NativeActionButton
        disabled={busy || (isOpenAiCompatible && !modelId.trim())}
        label={
          pending === "default"
            ? t("Switching…")
            : isActive && !usingServerCredentials
              ? t("Save")
              : t("Use this model")
        }
        onPress={() => void setModelDefault()}
        style={{ marginTop: 12 }}
      />
    ) : null;

  const connectedStatusRow = credential ? (
    <View style={styles.statusRow}>
      <View style={styles.providerCopy}>
        <Text style={styles.providerName}>
          {t("Connected · {label}", { label: credential.label })}
        </Text>
      </View>
      <NativeActionButton
        disabled={busy}
        fill={false}
        label={pending === "disconnect" ? t("Disconnecting…") : t("Disconnect")}
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
        prominence="destructive"
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
                    style={({ pressed }) => [styles.providerRow, pressed && styles.pressed]}
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
                    {group.id === provider ? <Checkmark /> : null}
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
              style={({ pressed }) => [styles.providerRow, pressed && styles.pressed]}
            >
              <View style={styles.providerCopy}>
                <Text style={styles.providerName}>{group.name}</Text>
                <Text style={styles.secondary}>
                  {t(group.entries.length === 1 ? "{count} model" : "{count} models", {
                    count: group.entries.length,
                  })}
                </Text>
              </View>
              {group.id === provider ? <Checkmark /> : null}
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
              {feedbackAnchor === "probe" ? null : feedback}
            </>
          ) : credential ? (
            <>
              {provider === me?.hostCredentialProvider ? serverCredentialsNote : null}
              {connectedStatusRow}
              <Text style={styles.sectionTitle}>{t("Model")}</Text>
              {catalogModelCard}
              {saveRow}
              {feedbackAnchor === "model" ? feedback : null}
              <View style={styles.maintenanceSection}>{catalogConnectionControls}</View>
              {feedbackAnchor === "model" ? null : feedback}
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
                  <Text style={styles.sectionTitle}>{t("Model")}</Text>
                  {catalogModelCard}
                </>
              ) : null}
            </>
          ) : (
            <>
              {catalogConnectionControls}
              {feedback}
              <Text style={styles.sectionTitle}>{t("Model")}</Text>
              {catalogModelCard}
            </>
          )
        ) : (
          feedback
        )}

        <View style={styles.backupSection}>
          <Text style={styles.backupTitle}>{t("Backup models")}</Text>
          {backupLoading ? (
            <ActivityIndicator color={native.secondaryLabel} />
          ) : backupModels.length ? (
            <View style={styles.backupCard}>
              {backupModels.map((choice, index) => {
                const row = backupRowLabel(choice);
                const key = backupChoiceKey(choice);
                return (
                  <View key={key} style={styles.backupRow}>
                    <View style={styles.backupCopy}>
                      <Text style={styles.backupModelLabel}>
                        {index + 1}. {row.label}
                      </Text>
                      {!row.connected ? (
                        <Text style={styles.backupUnavailable}>{t("Not connected")}</Text>
                      ) : null}
                    </View>
                    <View style={styles.backupActions}>
                      <NativeActionButton
                        accessibilityLabel={t("Move {model} up", { model: row.label })}
                        disabled={index === 0 || backupLocked}
                        onPress={() => {
                          if (
                            backupLoadingRef.current ||
                            !backupReadyRef.current ||
                            backupSavingRef.current
                          )
                            return;
                          setBackupModels((current) =>
                            moveBackupChoice(
                              current,
                              current.findIndex((entry) => backupChoiceKey(entry) === key),
                              -1,
                            ),
                          );
                          setBackupError(null);
                          setBackupNotice(null);
                        }}
                        label="↑"
                        prominence="quiet"
                      />
                      <NativeActionButton
                        accessibilityLabel={t("Move {model} down", { model: row.label })}
                        disabled={index === backupModels.length - 1 || backupLocked}
                        onPress={() => {
                          if (
                            backupLoadingRef.current ||
                            !backupReadyRef.current ||
                            backupSavingRef.current
                          )
                            return;
                          setBackupModels((current) =>
                            moveBackupChoice(
                              current,
                              current.findIndex((entry) => backupChoiceKey(entry) === key),
                              1,
                            ),
                          );
                          setBackupError(null);
                          setBackupNotice(null);
                        }}
                        label="↓"
                        prominence="quiet"
                      />
                      <NativeActionButton
                        accessibilityLabel={t("Remove {model}", { model: row.label })}
                        disabled={backupLocked}
                        onPress={() => {
                          if (
                            backupLoadingRef.current ||
                            !backupReadyRef.current ||
                            backupSavingRef.current
                          )
                            return;
                          setBackupModels((current) =>
                            current.filter((entry) => backupChoiceKey(entry) !== key),
                          );
                          setBackupError(null);
                          setBackupNotice(null);
                        }}
                        label={t("Remove")}
                        prominence="quiet"
                      />
                    </View>
                  </View>
                );
              })}
            </View>
          ) : (
            <Text style={styles.secondary}>
              {addableBackupOptions.length
                ? t("Add connected models to use them as backups.")
                : t("Connect a provider to add backups.")}
            </Text>
          )}
          {backupModels.length >= MAX_MODEL_BACKUPS ? (
            <Text style={styles.backupUnavailable}>{t("Maximum of 10 backup models.")}</Text>
          ) : null}
          <NativeActionButton
            accessibilityLabel={t("Add connected model")}
            disabled={
              backupLocked ||
              backupModels.length >= MAX_MODEL_BACKUPS ||
              addableBackupOptions.length === 0
            }
            onPress={openBackupModelPicker}
            label={t("Add connected model")}
            prominence="secondary"
          />
          <NativeActionButton
            accessibilityLabel={t("Save backups")}
            disabled={!backupDirty || backupLocked}
            onPress={() => void saveBackupModels()}
            label={backupSaving ? t("Saving…") : t("Save backups")}
            prominence="primary"
          />
          {backupError ? (
            <View style={{ gap: 8 }}>
              <Text accessibilityRole="alert" style={styles.error}>
                {backupError}
              </Text>
              {!backupReady && !backupLoading && me ? (
                <NativeActionButton
                  disabled={backupLoading || backupSaving}
                  onPress={() => void loadBackupModels(me)}
                  label={t("Retry")}
                  prominence="secondary"
                />
              ) : null}
            </View>
          ) : null}
          {backupNotice ? (
            <Text accessibilityRole="text" style={styles.secondary}>
              {backupNotice}
            </Text>
          ) : null}
        </View>
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
    backupSection: {
      gap: 12,
      marginTop: 16,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: native.fillPressed,
      paddingTop: 14,
    },
    backupTitle: {
      color: native.label,
      fontSize: 16,
      fontWeight: "600",
    },
    backupCard: {
      marginTop: 10,
      borderRadius: 14,
      backgroundColor: native.fill,
      overflow: "hidden",
    },
    backupRow: {
      minHeight: 56,
      paddingHorizontal: 12,
      paddingVertical: 8,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: native.fillPressed,
    },
    backupCopy: {
      flex: 1,
      minWidth: 0,
    },
    backupModelLabel: {
      color: native.label,
      fontSize: 14,
    },
    backupUnavailable: {
      color: native.tertiaryLabel,
      fontSize: 12,
      marginTop: 2,
    },
    backupActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 2,
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
    modelLabel: {
      flex: 1,
      color: native.label,
      fontSize: 15,
    },
    mutedLabel: {
      color: native.secondaryLabel,
    },
    singleRow: {
      borderBottomWidth: 0,
    },
    rowValue: {
      color: native.secondaryLabel,
      fontSize: 15,
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
    chevron: {
      width: 16,
      alignItems: "center",
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
