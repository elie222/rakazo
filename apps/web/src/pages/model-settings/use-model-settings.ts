import { useLingui } from "@lingui/react/macro";
import type { Me, ModelHeaderRow, ThinkingLevel } from "@rakazo/contracts";
import {
  CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
  cloudflareModelRouting,
  compatibleConnectionName,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  isCloudflareModelProvider,
  MAX_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_MAX_TOKENS,
  ModelHeaderRowsSchema,
  modelHeadersInput,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleConnectReady,
  openAiCompatibleProbeSuccessMessage,
  parseModelContextWindow,
  parseModelMaxImagesPerPrompt,
  parseModelMaxTokens,
  savedCompatibleEndpointMatches,
} from "@rakazo/contracts";
import {
  COMPATIBLE_THINKING_LEVELS,
  clampCatalogThinkingLevel,
  compatibleModelRows,
  createModelProbe,
  initialModelProbeState,
  pickCatalogModelId,
  popularModelProvidersFirst,
  savedCompatibleModelIds,
} from "@rakazo/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCopyText } from "../../lib/copy-text";
import { providerDisplayName } from "../../lib/localized-provider-hint";
import type { ModelCatalogEntry, ModelCredential } from "../../lib/model-auth";
import { thinkingLevelLabel } from "../../lib/model-catalog";
import type { ModelPreflightFailure } from "../../lib/model-connection-preflight";
import {
  classifyModelConnectionFailure,
  loadStoredModelAuth,
  modelPreflightSuccessMessage,
  runModelConnectionPreflight,
  unavailableSelectedModel,
} from "../../lib/model-connection-preflight";
import { useSpaceRpc } from "../../lib/space-rpc";
import { useModelOAuthSignIn } from "../../lib/use-model-oauth-signin";
import { errorText } from "../../lib/user-error";

function connectionMaxTokensField(providerId: string, stored: number | undefined): string {
  if (providerId === OPENAI_COMPATIBLE_PROVIDER_ID) {
    return String(stored ?? DEFAULT_MODEL_MAX_TOKENS);
  }
  return stored !== undefined ? String(stored) : "";
}

export function useModelSettings(onClose: () => void) {
  const rpc = useSpaceRpc();
  const { t } = useLingui();
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [provider, setProvider] = useState("");
  // The provider whose optional personal-key form is open.
  const [ownKeyProvider, setOwnKeyProvider] = useState<string | null>(null);
  const [providerQuery, setProviderQuery] = useState("");
  const [modelId, setModelId] = useState("");
  const modelIdRef = useRef(modelId);
  modelIdRef.current = modelId;
  const [enabledModelIds, setEnabledModelIds] = useState<string[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [gatewayId, setGatewayId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [headerRows, setHeaderRows] = useState<ModelHeaderRow[] | null>(null);
  const [reasoning, setReasoning] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | null>(null);
  const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MODEL_MAX_TOKENS));
  const [contextWindow, setContextWindow] = useState(String(DEFAULT_MODEL_CONTEXT_WINDOW));
  const [supportsImages, setSupportsImages] = useState(false);
  const [maxImagesPerPrompt, setMaxImagesPerPrompt] = useState("");
  const [{ models: probeModels, probing }, setProbe] = useState(initialModelProbeState);
  const [modelProbe] = useState(() => createModelProbe(setProbe));
  const resetOpenAiCompatibleProbe = modelProbe.reset;
  const [codeCopied, copyOAuthCode] = useCopyText();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"connect" | "settings" | "default" | "disconnect" | null>(
    null,
  );
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preflightTesting, setPreflightTesting] = useState(false);
  const [preflightTarget, setPreflightTarget] = useState<
    "api-key" | "sign-in" | "compatible" | null
  >(null);
  const [preflightSuccess, setPreflightSuccess] = useState<string | null>(null);
  const [preflightFailure, setPreflightFailure] = useState<ModelPreflightFailure | null>(null);
  const preflightRevisionRef = useRef(0);
  const detailScrollRef = useRef<HTMLDivElement>(null);
  const refreshRevisionRef = useRef(0);
  const selectionRevisionRef = useRef(0);
  const selectedLabelRef = useRef<string | undefined>(undefined);

  const {
    oauth,
    pasteCode,
    setPasteCode,
    oauthPending,
    popupBlocked,
    cancelOAuthAttempt,
    startSubscriptionSignIn,
    submitOAuthCode,
  } = useModelOAuthSignIn({
    onClearError: () => setError(null),
    onError: setError,
    onFinished: async () => {
      await refresh();
    },
  });

  async function refresh() {
    const refreshRevision = ++refreshRevisionRef.current;
    const selectionRevision = selectionRevisionRef.current;
    const [nextCatalog, nextCredentials, nextMe] = await Promise.all([
      rpc.models.list(),
      rpc.models.credentials(),
      rpc.me(),
    ]);
    if (refreshRevision !== refreshRevisionRef.current) return;
    const nextProvider =
      provider && nextCatalog.some((entry) => entry.provider === provider)
        ? provider
        : (nextMe.defaultProvider ?? nextCatalog[0]?.provider ?? "");
    const nextCredential = nextCredentials.find((entry) => entry.provider === nextProvider);
    const nextModel =
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? (nextCredential?.modelId ??
          (nextMe.defaultProvider === OPENAI_COMPATIBLE_PROVIDER_ID ? nextMe.defaultModel : "") ??
          "")
        : (nextCatalog.find((entry) => entry.provider === nextProvider && entry.id === modelId)
            ?.id ??
          pickCatalogModelId(
            nextCatalog,
            nextProvider,
            nextCredential?.modelId ??
              (nextProvider === nextMe.defaultProvider ? nextMe.defaultModel : null),
          ));
    setCatalog(nextCatalog);
    setCredentials(nextCredentials);
    setMe(nextMe);
    if (selectionRevision === selectionRevisionRef.current) {
      invalidatePreflight();
      resetOpenAiCompatibleProbe();
      setProvider(nextProvider);
      setModelId(nextModel);
      setEnabledModelIds(nextCredential?.enabledModelIds ?? []);
      if (nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID) {
        setBaseUrl(nextCredential?.baseUrl ?? "");
        setHeaderRows(null);
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
    }
  }

  useEffect(() => {
    void refresh()
      .catch((err: unknown) => setError(errorText(err, t`Could not load model settings`)))
      .finally(() => setLoading(false));
    return () => {
      refreshRevisionRef.current += 1;
      modelProbe.invalidate();
    };
  }, []);

  const groups = useMemo(() => {
    const grouped = new Map<string, ModelCatalogEntry[]>();
    for (const entry of catalog) {
      const entries = grouped.get(entry.provider) ?? [];
      entries.push(entry);
      grouped.set(entry.provider, entries);
    }
    return popularModelProvidersFirst(
      [...grouped].map(([id, entries]) => ({
        id,
        name: providerDisplayName(
          id,
          entries[0]?.providerName ?? id,
          credentials.find((entry) => entry.provider === id)?.authKind,
        ),
        entries,
      })),
      (group) => group.id,
    );
  }, [catalog, credentials]);
  const credentialByProvider = useMemo(
    () => new Map(credentials.map((entry) => [entry.provider, entry])),
    [credentials],
  );
  const connectedProviderIds = useMemo(
    () => new Set(credentials.map((entry) => entry.provider)),
    [credentials],
  );
  const searching = providerQuery.trim() !== "";
  const filteredGroups = useMemo(() => {
    const query = providerQuery.trim().toLowerCase();
    const matched = query
      ? groups.filter((group) =>
          [
            group.id,
            group.name,
            group.id === OPENAI_COMPATIBLE_PROVIDER_ID ? "Ollama Cloud" : "",
            ...group.entries.flatMap((entry) => [entry.id, entry.label]),
          ]
            .join(" ")
            .toLowerCase()
            .includes(query),
        )
      : groups;
    // Rank exact/prefix provider-name hits above incidental substring matches,
    // then float connected providers so they are reachable without scrolling.
    const score = (group: (typeof groups)[number]) =>
      query
        ? group.id.toLowerCase().startsWith(query) || group.name.toLowerCase().startsWith(query)
          ? 0
          : group.name.toLowerCase().includes(query) || group.id.toLowerCase().includes(query)
            ? 1
            : 2
        : 0;
    return [...matched].sort(
      (a, b) =>
        score(a) - score(b) ||
        Number(connectedProviderIds.has(b.id)) - Number(connectedProviderIds.has(a.id)),
    );
  }, [groups, providerQuery, connectedProviderIds]);
  // Browsing separates connected providers into their own section; searching
  // flattens back into one ranked list.
  const connectedGroups = useMemo(
    () => (searching ? [] : filteredGroups.filter((group) => connectedProviderIds.has(group.id))),
    [searching, filteredGroups, connectedProviderIds],
  );
  const otherGroups = useMemo(
    () =>
      searching
        ? filteredGroups
        : filteredGroups.filter((group) => !connectedProviderIds.has(group.id)),
    [searching, filteredGroups, connectedProviderIds],
  );
  const modelsForProvider = catalog.filter((entry) => entry.provider === provider);
  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  selectedLabelRef.current = selected?.label;
  const selectedProviderName = compatibleConnectionName(
    baseUrl,
    groups.find((group) => group.id === provider)?.name ?? provider,
  );
  const disconnectName = selectedProviderName;
  const hostCredentialSource = me?.hostCredentialSource ?? "";
  const isOpenAiCompatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const isCloudflareGateway = provider === CLOUDFLARE_AI_GATEWAY_PROVIDER_ID;
  const isCloudflare = isCloudflareModelProvider(provider);
  const cloudflareRoutingReady =
    !isCloudflare || cloudflareModelRouting({ provider, accountId, gatewayId }) !== undefined;
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
      ? thinkingLevelLabel(activeCredential?.thinkingLevel ?? "medium")
      : null;
  const isActive =
    me?.defaultProvider === selected?.provider &&
    me?.defaultModel === (isOpenAiCompatible ? modelId.trim() : selected?.id);
  // Space still bills the host while this provider matches; model id alone is not credentials.
  const usingServerCredentials = provider === me?.hostCredentialProvider;
  const acceptsKey = selected?.auth !== "oauth";
  const subscriptionSignIn = selected?.signIn !== undefined;
  // Effort levels for the staged catalog model — "off" stays out, matching the
  // per-bot Thinking picker.
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
  const savedHeaderEndpointMatches = savedCompatibleEndpointMatches(baseUrl, credential?.baseUrl);
  const effectiveBaseUrl = baseUrl.trim();
  const openAiCompatibleReady = openAiCompatibleConnectReady({
    apiKey:
      apiKey ||
      (credential?.hasKey && savedCompatibleEndpointMatches(effectiveBaseUrl, credential.baseUrl)
        ? "stored"
        : ""),
    baseUrl: effectiveBaseUrl,
    modelId:
      headerRows !== null && !ModelHeaderRowsSchema.safeParse(headerRows).success ? "" : modelId,
  });
  const compatibleRows = compatibleModelRows(
    savedCompatibleModelIds(credential, baseUrl),
    enabledModelIds,
    probeModels,
  );
  const defaultModelOptions = [...new Set([...enabledModelIds, modelId])];
  // Saved-connection settings edited without a new key (output limit, gateway ids).
  const settingsDirty =
    !isOpenAiCompatible &&
    Boolean(credential) &&
    (maxTokens.trim() !== connectionMaxTokensField(provider, credential?.maxTokens) ||
      (isCloudflare &&
        (accountId.trim() !== (credential?.accountId ?? "") ||
          gatewayId.trim() !== (credential?.gatewayId ?? ""))));

  function invalidatePreflight() {
    preflightRevisionRef.current += 1;
    setPreflightTesting(false);
    setPreflightTarget(null);
    setPreflightSuccess(null);
    setPreflightFailure(null);
  }

  function preflightStillCurrent(revision: number): boolean {
    return revision === preflightRevisionRef.current;
  }

  function updateBaseUrl(nextBaseUrl: string) {
    setBaseUrl(nextBaseUrl);
    setHeaderRows(null);
    // A new endpoint starts with no ticks; the saved endpoint gets its saved list back.
    setEnabledModelIds(savedCompatibleModelIds(credential, nextBaseUrl));
    resetOpenAiCompatibleProbe();
    invalidatePreflight();
    setError(null);
    setNotice(null);
  }

  function updateApiKey(nextApiKey: string) {
    setApiKey(nextApiKey);
    resetOpenAiCompatibleProbe();
    invalidatePreflight();
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

  function chooseProvider(nextProvider: string, presetBaseUrl?: string) {
    cancelOAuthAttempt();
    selectionRevisionRef.current += 1;
    const nextCredential = credentials.find(
      (entry) =>
        entry.provider === nextProvider && (!presetBaseUrl || entry.baseUrl === presetBaseUrl),
    );
    const nextModelId =
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? (nextCredential?.modelId ?? "")
        : pickCatalogModelId(
            catalog,
            nextProvider,
            nextCredential?.modelId ??
              (nextProvider === me?.defaultProvider ? me.defaultModel : null),
          );
    setProvider(nextProvider);
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
    setEnabledModelIds(nextCredential?.enabledModelIds ?? []);
    setBaseUrl(
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? (presetBaseUrl ?? nextCredential?.baseUrl ?? "")
        : "",
    );
    detailScrollRef.current?.scrollTo({ top: 0 });
    setApiKey("");
    setHeaderRows(null);
    setAccountId(nextCredential?.accountId ?? "");
    setGatewayId(nextCredential?.gatewayId ?? "");
    resetOpenAiCompatibleProbe();
    invalidatePreflight();
    setError(null);
    setNotice(null);
  }

  async function probeServerModels() {
    if (!baseUrl.trim()) return;
    const revision = preflightRevisionRef.current;
    setError(null);
    setNotice(null);
    setPreflightSuccess(null);
    setPreflightFailure(null);
    setPreflightTarget("compatible");
    await modelProbe.probe({
      baseUrl,
      apiKey,
      request: (input) =>
        rpc.models.probeOpenAiCompatible({
          ...input,
          headers: modelHeadersInput(headerRows),
          credentialId: credential?.id,
        }),
      onSuccess: (models) => {
        if (!preflightStillCurrent(revision)) return;
        const current = modelIdRef.current;
        const next = current.trim() || models[0] || "";
        if (next !== current) stageCompatibleModelId(next);
        else setModelId(next);
        const unavailable = unavailableSelectedModel(current, models);
        if (unavailable) {
          setPreflightFailure(unavailable);
          setNotice(null);
          return;
        }
        setPreflightTarget(null);
        setPreflightFailure(null);
        setNotice(openAiCompatibleProbeSuccessMessage(models.length));
      },
      onError: (err) => {
        if (!preflightStillCurrent(revision)) return;
        setPreflightFailure(classifyModelConnectionFailure(err, { modelId }));
        setNotice(null);
      },
    });
  }

  async function testApiKeyConnection() {
    if (!selected?.catalogProbe) return;
    const revision = preflightRevisionRef.current;
    setPreflightTarget("api-key");
    setPreflightTesting(true);
    setPreflightSuccess(null);
    setPreflightFailure(null);
    setError(null);
    setNotice(null);
    const result = await runModelConnectionPreflight({
      authKind: "api-key",
      provider: selected.provider,
      apiKey,
      modelId: selected.id,
      catalogProbe: true,
      probeCatalog: rpc.models.probeCatalog,
    });
    if (!preflightStillCurrent(revision)) return;
    setPreflightTesting(false);
    if (result.ok) {
      setPreflightSuccess(modelPreflightSuccessMessage(result.discoveredModels.length));
      return;
    }
    setPreflightFailure(result.failure);
  }

  async function testOAuthConnection() {
    if (!selected) return;
    const revision = preflightRevisionRef.current;
    setPreflightTarget("sign-in");
    setPreflightTesting(true);
    setPreflightSuccess(null);
    setPreflightFailure(null);
    setError(null);
    setNotice(null);
    const stored = await loadStoredModelAuth(
      selected.provider,
      () => rpc.models.credentials(),
      selected.id,
    );
    if (!preflightStillCurrent(revision)) return;
    const result = await runModelConnectionPreflight({
      authKind: "oauth",
      provider: selected.provider,
      ...stored,
    });
    if (!preflightStillCurrent(revision)) return;
    setPreflightTesting(false);
    if (result.ok) {
      setPreflightSuccess(t`A subscription credential is stored securely.`);
      return;
    }
    setPreflightFailure(result.failure);
  }

  async function setModelDefault() {
    if (!selected || !credential) return;
    const activeModelId = isOpenAiCompatible ? modelId.trim() : selected.id;
    if (isOpenAiCompatible && !activeModelId) return;
    setError(null);
    setNotice(null);
    setPending("default");
    try {
      await rpc.models.setDefault({
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
      await refresh();
      setNotice(isOpenAiCompatible ? t`Model updated.` : t`Now using ${selected.label}.`);
    } catch (err) {
      setError(errorText(err, t`Could not change the default model`));
    } finally {
      setPending(null);
    }
  }

  // settingsOnly saves a connected catalog provider's limits and gateway ids
  // without touching the key field; key replacement stays on its own button.
  async function connectKey({ settingsOnly = false }: { settingsOnly?: boolean } = {}) {
    if (!selected) return;
    const newKey = settingsOnly ? "" : apiKey.trim();
    const savingLimitOnly = !isOpenAiCompatible && !newKey;
    const activeModelId = isOpenAiCompatible ? modelId.trim() : selected.id;
    const supportedThinking = isOpenAiCompatible
      ? reasoning
        ? COMPATIBLE_THINKING_LEVELS
        : []
      : selected.thinkingLevels;
    // The staged effort belongs to the model on screen. Clamp it before connect
    // or a limit save so a previous model's level cannot stick.
    const stagedThinking = clampCatalogThinkingLevel(
      thinkingLevel,
      supportedThinking,
    ) as ThinkingLevel | null;
    const modelChanged = (credential?.modelId ?? null) !== (activeModelId || null);
    if (isOpenAiCompatible) {
      if (!effectiveBaseUrl || !modelId.trim()) return;
    } else if (savingLimitOnly) {
      if (!credential) return;
    } else if (newKey.length < 8) {
      return;
    }
    const parsedMaxTokens = maxTokens.trim() ? parseModelMaxTokens(maxTokens) : undefined;
    if ((isOpenAiCompatible || maxTokens.trim()) && parsedMaxTokens === undefined) {
      setError(
        t`Enter a whole number from 1 to ${MAX_MODEL_MAX_TOKENS} for maximum output tokens.`,
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
      setError(t`Enter a whole number from 1 to 1000 for the image limit.`);
      return;
    }
    const maxImagesPerPromptInput =
      supportsImages && !maxImagesPerPrompt.trim() ? null : parsedMaxImagesPerPrompt;
    const parsedContextWindow = isOpenAiCompatible
      ? parseModelContextWindow(contextWindow)
      : undefined;
    if (isOpenAiCompatible && parsedContextWindow === undefined) {
      setError(
        t`Enter a whole number from 1 to ${MAX_MODEL_CONTEXT_WINDOW} for the context limit.`,
      );
      return;
    }
    if (isOpenAiCompatible && parsedMaxTokens === undefined) return;
    setError(null);
    setNotice(null);
    setPending(settingsOnly ? "settings" : "connect");
    try {
      await rpc.models.connect(
        isOpenAiCompatible
          ? {
              provider: selected.provider,
              baseUrl: effectiveBaseUrl,
              headers: modelHeadersInput(headerRows),
              modelId: modelId.trim(),
              // The server adds the default itself.
              enabledModelIds: enabledModelIds.filter((id) => id !== modelId.trim()),
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
              ...(newKey ? { apiKey: newKey } : {}),
              ...(isCloudflare ? { accountId: accountId.trim(), gatewayId: gatewayId.trim() } : {}),
              modelId: selected.id,
              // A limits-only save leaves the stored effort alone while the model
              // stays put. Changing the model sends the clamped level, including
              // null, so the previous model's effort is not reused.
              ...(!savingLimitOnly || modelChanged || thinkingDirty
                ? { thinkingLevel: stagedThinking }
                : {}),
              maxTokens: parsedMaxTokens ?? null,
              label: selected.providerName ?? selected.provider,
            },
      );
      if (!settingsOnly) setApiKey("");
      await refresh();
      detailScrollRef.current?.scrollTo({ top: 0 });
      // A fresh connection speaks for itself through the Active model row.
      if (isOpenAiCompatible || savingLimitOnly) setNotice(t`Saved.`);
    } catch (err) {
      setError(errorText(err, t`Could not connect this provider`));
    } finally {
      setPending(null);
    }
  }

  async function disconnectCredential() {
    if (!selected || !credential) return;
    cancelOAuthAttempt();
    setError(null);
    setNotice(null);
    setPending("disconnect");
    try {
      await rpc.models.disconnect({ provider: selected.provider });
      setApiKey("");
      setThinkingLevel(null);
      await refresh();
      detailScrollRef.current?.scrollTo({ top: 0 });
      setNotice(t`Disconnected ${selected.providerName ?? selected.provider}.`);
    } catch (err) {
      setError(errorText(err, t`Could not disconnect this provider`));
    } finally {
      setPending(null);
    }
  }

  function handleClose() {
    cancelOAuthAttempt(false);
    onClose();
  }

  function beginSelectedSubscriptionSignIn() {
    if (!selected) return;
    setNotice(null);
    void startSubscriptionSignIn({
      provider: selected.provider,
      modelId: selected.id,
      thinkingLevel: clampCatalogThinkingLevel(
        thinkingLevel,
        selected.thinkingLevels,
      ) as ThinkingLevel | null,
      label: selected.providerName ?? selected.provider,
    });
  }

  return {
    resetOpenAiCompatibleProbe,
    headerRows,
    setHeaderRows,
    savedHeaderEndpointMatches,
    acceptsKey,
    accountId,
    activeThinkingLabel,
    apiKey,
    baseUrl,
    beginSelectedSubscriptionSignIn,
    busy,
    cancelOAuthAttempt,
    catalog,
    catalogThinkingLevels,
    chooseProvider,
    cloudflareRoutingReady,
    codeCopied,
    compatibleRows,
    confirmDisconnect,
    connectKey,
    connectedGroups,
    contextWindow,
    copyOAuthCode,
    credential,
    credentialByProvider,
    credentials,
    currentEntry,
    defaultModelOptions,
    detailScrollRef,
    disconnectCredential,
    disconnectName,
    effectiveBaseUrl,
    enabledModelIds,
    error,
    filteredGroups,
    gatewayId,
    groups,
    handleClose,
    hostCredentialSource,
    invalidatePreflight,
    isActive,
    isCloudflare,
    isCloudflareGateway,
    isOpenAiCompatible,
    loading,
    maxImagesPerPrompt,
    maxTokens,
    me,
    modelId,
    modelsForProvider,
    notice,
    oauth,
    oauthPending,
    openAiCompatibleReady,
    otherGroups,
    ownKeyProvider,
    pasteCode,
    pending,
    popupBlocked,
    preflightFailure,
    preflightSuccess,
    preflightTarget,
    preflightTesting,
    probeModels,
    probeServerModels,
    probing,
    provider,
    providerQuery,
    reasoning,
    selected,
    selectedProviderName,
    selectionRevisionRef,
    setAccountId,
    setConfirmDisconnect,
    setContextWindow,
    setEnabledModelIds,
    setError,
    setGatewayId,
    setMaxImagesPerPrompt,
    setMaxTokens,
    setModelDefault,
    setModelId,
    setNotice,
    setOwnKeyProvider,
    setPasteCode,
    setProviderQuery,
    setReasoning,
    setSupportsImages,
    setThinkingLevel,
    settingsDirty,
    stageCompatibleModelId,
    submitOAuthCode,
    subscriptionSignIn,
    supportsImages,
    testApiKeyConnection,
    testOAuthConnection,
    thinkingDirty,
    thinkingLevel,
    updateApiKey,
    updateBaseUrl,
    usingServerCredentials,
  };
}
export type ModelSettingsState = ReturnType<typeof useModelSettings>;
