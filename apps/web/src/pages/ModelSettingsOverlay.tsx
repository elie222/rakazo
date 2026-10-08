import { i18n } from "@lingui/core";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { Me, ThinkingLevel } from "@rakazo/contracts";
import {
  CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
  cloudflareGatewayRouting,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  MAX_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_MAX_TOKENS,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleConnectReady,
  openAiCompatibleProbeSuccessMessage,
  parseModelContextWindow,
  parseModelMaxImagesPerPrompt,
  parseModelMaxTokens,
} from "@rakazo/contracts";
import {
  COMPATIBLE_THINKING_LEVELS,
  clampCatalogThinkingLevel,
  createModelProbe,
  filterModelCatalog,
  initialModelProbeState,
  pickCatalogModelId,
} from "@rakazo/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  ModelThinkingOptions,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
import { Check, ChevronDown, Copy, X } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ModelPreflightFeedback,
  modelPreflightTestingLabel,
} from "../components/ModelConnectionPreflightNotice";
import { useCopyText } from "../lib/copy-text";
import { localizedProviderHint } from "../lib/localized-provider-hint";
import type { ModelCatalogEntry, ModelCredential } from "../lib/model-auth";
import { thinkingLevelLabel } from "../lib/model-catalog";
import type { ModelPreflightFailure } from "../lib/model-connection-preflight";
import {
  classifyModelConnectionFailure,
  loadStoredModelAuth,
  modelPreflightSuccessMessage,
  runModelConnectionPreflight,
  unavailableSelectedModel,
} from "../lib/model-connection-preflight";
import { rpc } from "../lib/rpc";
import { useModelOAuthSignIn } from "../lib/use-model-oauth-signin";
import { errorText } from "../lib/user-error";
import { ModelBackupsSettings } from "./ModelBackupsSettings";

function connectionMaxTokensField(providerId: string, stored: number | undefined): string {
  if (providerId === OPENAI_COMPATIBLE_PROVIDER_ID) {
    return String(stored ?? DEFAULT_MODEL_MAX_TOKENS);
  }
  return stored !== undefined ? String(stored) : "";
}

export function ModelSettingsOverlay({
  onClose,
  embedded = false,
  localOwner = false,
}: {
  onClose: () => void;
  /** Render panel body only for the shared Settings shell. */
  embedded?: boolean;
  localOwner?: boolean;
}) {
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
  const [{ models: probeModels, probing }, setProbe] = useState(initialModelProbeState);
  const [modelProbe] = useState(() => createModelProbe(setProbe));
  const resetOpenAiCompatibleProbe = modelProbe.reset;
  const [codeCopied, copyOAuthCode] = useCopyText();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"connect" | "default" | "disconnect" | null>(null);
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
    onFinished: async (controller) => {
      await refresh();
      if (controller.signal.aborted) return;
      setNotice(t`Connected and using ${selectedLabelRef.current ?? "this model"}.`);
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
            nextCredential?.modelId ?? nextMe.defaultModel,
          ));
    setCatalog(nextCatalog);
    setCredentials(nextCredentials);
    setMe(nextMe);
    if (selectionRevision === selectionRevisionRef.current) {
      invalidatePreflight();
      resetOpenAiCompatibleProbe();
      setProvider(nextProvider);
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
    return [...grouped].map(([id, entries]) => ({
      id,
      name: entries[0]?.providerName ?? id,
      entries,
    }));
  }, [catalog]);
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
          [group.id, group.name, ...group.entries.flatMap((entry) => [entry.id, entry.label])]
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
  const selectedProviderName = selected?.providerName ?? selected?.provider ?? "";
  const disconnectName = selectedProviderName;
  const hostCredentialSource = me?.hostCredentialSource ?? "";
  const serverCredentialsNote = (
    <p className="text-sm leading-[1.5] text-muted-foreground">
      <Trans>
        Uses this server's own {hostCredentialSource} credentials to access {selectedProviderName}.
      </Trans>
    </p>
  );
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
  const effectiveBaseUrl = baseUrl.trim();
  const openAiCompatibleReady = openAiCompatibleConnectReady({
    baseUrl: effectiveBaseUrl,
    modelId,
  });
  const builtinLimitSave = !isOpenAiCompatible && Boolean(credential) && apiKey.trim().length === 0;

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

  function chooseProvider(nextProvider: string) {
    cancelOAuthAttempt();
    selectionRevisionRef.current += 1;
    const nextCredential = credentials.find((entry) => entry.provider === nextProvider);
    const nextModelId =
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? (nextCredential?.modelId ?? "")
        : pickCatalogModelId(catalog, nextProvider, nextCredential?.modelId ?? me?.defaultModel);
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
    setBaseUrl(
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID ? (nextCredential?.baseUrl ?? "") : "",
    );
    detailScrollRef.current?.scrollTo({ top: 0 });
    setApiKey("");
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
      request: rpc.models.probeOpenAiCompatible,
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

  async function connectKey() {
    if (!selected) return;
    const savingLimitOnly = !isOpenAiCompatible && !apiKey.trim();
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
    } else if (apiKey.trim().length < 8) {
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
    setPending("connect");
    try {
      await rpc.models.connect(
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
              ...(isCloudflareGateway
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
      await refresh();
      detailScrollRef.current?.scrollTo({ top: 0 });
      setNotice(
        isOpenAiCompatible || savingLimitOnly
          ? t`Saved.`
          : t`Connected and using ${selected.label}.`,
      );
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

  function renderProviderRow(group: (typeof groups)[number], connectedSection: boolean) {
    const rowCredential = credentialByProvider.get(group.id);
    const savedModelLabel = rowCredential?.modelId
      ? (group.entries.find((entry) => entry.id === rowCredential.modelId)?.label ??
        rowCredential.modelId)
      : null;
    return (
      <button
        key={group.id}
        type="button"
        aria-current={group.id === provider ? "true" : undefined}
        onClick={() => chooseProvider(group.id)}
        className={`flex w-full items-center gap-3 border-b border-border px-3.5 py-3 text-start last:border-0 ${
          group.id === provider ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
        }`}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] text-foreground">{group.name}</span>
          <span className="mt-0.5 block truncate text-[12px] text-muted-foreground/80">
            {connectedSection && savedModelLabel ? (
              savedModelLabel
            ) : (
              <>
                <Plural value={group.entries.length} one="# model" other="# models" />
                {" · "}
                {localizedProviderHint(group.entries[0]!)}
              </>
            )}
          </span>
        </span>
        {!connectedSection && rowCredential ? (
          <span className="text-[12px] text-success">
            <Trans>Connected</Trans>
          </span>
        ) : null}
      </button>
    );
  }

  // The staged model's own configuration block: picker, effort, billing note.
  const catalogModelConfig =
    !isOpenAiCompatible && selected ? (
      <>
        <div className="block text-[13.5px] text-muted-foreground">
          <span>
            <Trans>Model</Trans>
          </span>
          <ModelPicker
            options={modelsForProvider}
            value={selected.id}
            onChange={(nextModelId) => {
              cancelOAuthAttempt();
              selectionRevisionRef.current += 1;
              invalidatePreflight();
              setModelId(nextModelId);
              const nextEntry = modelsForProvider.find((entry) => entry.id === nextModelId);
              setThinkingLevel(
                clampCatalogThinkingLevel(
                  nextModelId === credential?.modelId ? credential?.thinkingLevel : null,
                  nextEntry?.thinkingLevels,
                ) as ThinkingLevel | null,
              );
              setError(null);
              setNotice(null);
            }}
          />
          <ModelThinkingOptions
            showThinking={false}
            disabled={busy}
            advancedLabel={t`Advanced`}
            maxTokens={maxTokens}
            onMaxTokensChange={(value) => {
              selectionRevisionRef.current += 1;
              setMaxTokens(value);
              setNotice(null);
            }}
            maxTokensLabel={t`Maximum output tokens`}
          />
        </div>
        {catalogThinkingLevels.length ? (
          <label
            className="mt-4 block text-[13.5px] text-muted-foreground"
            htmlFor="model-thinking-level"
          >
            <Trans>Thinking</Trans>
            <NativeSelect
              id="model-thinking-level"
              className="mt-2 w-full text-foreground"
              value={thinkingLevel ?? ""}
              disabled={busy}
              onChange={(event) => {
                selectionRevisionRef.current += 1;
                setThinkingLevel((event.target.value || null) as ThinkingLevel | null);
                setNotice(null);
              }}
            >
              <NativeSelectOption value="">
                {i18n._({
                  id: "Default ({0})",
                  message: "Default ({0})",
                  values: { "0": thinkingLevelLabel("medium") },
                })}
              </NativeSelectOption>
              {catalogThinkingLevels.map((level) => (
                <NativeSelectOption key={level} value={level}>
                  {thinkingLevelLabel(level)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        ) : null}
        {selected.billing && !usingServerCredentials ? (
          <p className="mt-2 text-[13px] leading-[1.5] text-muted-foreground">{selected.billing}</p>
        ) : null}
      </>
    ) : null;

  // Sign-in/key controls shared between the unconnected connect flow and the
  // connected maintenance area.
  const connectionControls = !isOpenAiCompatible ? (
    <>
      {subscriptionSignIn ? (
        <div className="mt-5 first:mt-0">
          {oauth ? (
            <div className="rounded-xl border border-border px-4 py-3">
              {oauth.mode === "auth-url" ? (
                <>
                  <p className="text-sm leading-[1.5] text-muted-foreground">
                    {popupBlocked ? (
                      <Trans>
                        Open{" "}
                        <a
                          href={oauth.verificationUri}
                          target="_blank"
                          rel="noreferrer"
                          className="text-foreground underline"
                        >
                          {new URL(oauth.verificationUri).hostname}
                        </a>{" "}
                        to finish signing in.
                      </Trans>
                    ) : (
                      <Trans>
                        Finish signing in at{" "}
                        <a
                          href={oauth.verificationUri}
                          target="_blank"
                          rel="noreferrer"
                          className="text-foreground underline"
                        >
                          {new URL(oauth.verificationUri).hostname}
                        </a>
                        . The final page may not load; paste its URL or code here.
                      </Trans>
                    )}
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <Input
                      value={pasteCode}
                      onChange={(e) => setPasteCode(e.target.value)}
                      aria-label={t`Authorization code or callback URL`}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="http://localhost:53692/callback?code=…"
                      className="text-foreground md:text-[13px]"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!pasteCode.trim()}
                      onClick={() => void submitOAuthCode()}
                    >
                      <Trans>Submit</Trans>
                    </Button>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    <Plural
                      value={Math.ceil(oauth.expiresInSeconds / 60)}
                      one="Waiting for sign-in — the link expires in about # minute."
                      other="Waiting for sign-in — the link expires in about # minutes."
                    />
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm leading-[1.5] text-muted-foreground">
                    {popupBlocked ? (
                      <Trans>
                        Open{" "}
                        <a
                          href={oauth.verificationUri}
                          target="_blank"
                          rel="noreferrer"
                          className="text-foreground underline"
                        >
                          {oauth.verificationUri.replace(/^https:\/\//, "")}
                        </a>{" "}
                        and enter this code:
                      </Trans>
                    ) : (
                      <Trans>
                        A sign-in tab opened at{" "}
                        <a
                          href={oauth.verificationUri}
                          target="_blank"
                          rel="noreferrer"
                          className="text-foreground underline"
                        >
                          {oauth.verificationUri.replace(/^https:\/\//, "")}
                        </a>
                        . Enter this code there — this window keeps waiting:
                      </Trans>
                    )}
                  </p>
                  <div className="mt-2 flex items-center gap-3">
                    <p className="font-mono text-[22px] tracking-[0.2em] text-foreground">
                      {oauth.userCode}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => copyOAuthCode(oauth.userCode)}
                    >
                      {codeCopied ? (
                        <Check size={14} strokeWidth={1.8} aria-hidden="true" />
                      ) : (
                        <Copy size={14} strokeWidth={1.8} aria-hidden="true" />
                      )}
                      {codeCopied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
                    </Button>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    <Plural
                      value={Math.ceil(oauth.expiresInSeconds / 60)}
                      one="Waiting for sign-in — the code expires in about # minute."
                      other="Waiting for sign-in — the code expires in about # minutes."
                    />
                  </p>
                </>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2 -ml-2 text-muted-foreground"
                onClick={() => cancelOAuthAttempt()}
              >
                <Trans>Cancel</Trans>
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => beginSelectedSubscriptionSignIn()}
            >
              {oauthPending ? (
                <Trans>Starting…</Trans>
              ) : credential?.authKind === "oauth" ? (
                <Trans>Sign in again</Trans>
              ) : (
                (selected.oauthLabel ?? t`Sign in`)
              )}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            disabled={busy || preflightTesting}
            onClick={() => void testOAuthConnection()}
          >
            {modelPreflightTestingLabel(
              preflightTesting && preflightTarget === "sign-in",
              "sign-in",
            )}
          </Button>
          {preflightTarget === "sign-in" ? (
            <ModelPreflightFeedback success={preflightSuccess} failure={preflightFailure} />
          ) : null}
        </div>
      ) : null}

      {acceptsKey || builtinLimitSave ? (
        <div className="mt-5 first:mt-0">
          {isCloudflareGateway ? (
            <>
              <label
                className="block text-[13.5px] text-muted-foreground"
                htmlFor="cloudflare-account-id"
              >
                <Trans>Account ID</Trans>
                <Input
                  id="cloudflare-account-id"
                  value={accountId}
                  onChange={(event) => setAccountId(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-2 h-10 text-foreground"
                />
              </label>
              <label
                className="mt-4 block text-[13.5px] text-muted-foreground"
                htmlFor="cloudflare-gateway-id"
              >
                <Trans>Gateway ID</Trans>
                <Input
                  id="cloudflare-gateway-id"
                  value={gatewayId}
                  onChange={(event) => setGatewayId(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-2 h-10 text-foreground"
                />
              </label>
            </>
          ) : null}
          {acceptsKey ? (
            <label
              className={`block text-[13.5px] text-muted-foreground ${isCloudflareGateway ? "mt-4" : ""}`}
              htmlFor="model-api-key"
            >
              {credential ? (
                <Trans>Replace API key</Trans>
              ) : subscriptionSignIn ? (
                <Trans>Or connect an API key</Trans>
              ) : (
                <Trans>API key</Trans>
              )}
              <Input
                id="model-api-key"
                value={apiKey}
                onChange={(event) => updateApiKey(event.target.value)}
                placeholder={credential?.hasKey ? t`Paste a replacement key` : "sk-…"}
                type="password"
                autoComplete="new-password"
                className="mt-2 h-10 text-foreground"
              />
            </label>
          ) : null}
          {acceptsKey && selected?.catalogProbe ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3 rounded-full"
                disabled={busy || preflightTesting || apiKey.trim().length < 8}
                onClick={() => void testApiKeyConnection()}
              >
                {modelPreflightTestingLabel(
                  preflightTesting && preflightTarget === "api-key",
                  "api-key",
                )}
              </Button>
              {preflightTarget === "api-key" ? (
                <ModelPreflightFeedback success={preflightSuccess} failure={preflightFailure} />
              ) : null}
            </>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            className="mt-3 rounded-full"
            size="sm"
            disabled={
              busy || !cloudflareRoutingReady || (!builtinLimitSave && apiKey.trim().length < 8)
            }
            onClick={() => void connectKey()}
          >
            {pending === "connect" ? (
              <Trans>Saving…</Trans>
            ) : builtinLimitSave ? (
              <Trans>Save limits</Trans>
            ) : credential ? (
              <Trans>Replace API key</Trans>
            ) : (
              <Trans>Connect API key</Trans>
            )}
          </Button>
        </div>
      ) : null}

      {selected?.auth === "oauth" && !subscriptionSignIn ? (
        <p className="mt-5 text-sm leading-[1.5] text-muted-foreground first:mt-0">
          <Trans>
            This subscription sign-in is not available in Rakazo yet. Use a deployment credential or
            choose another provider.
          </Trans>
        </p>
      ) : null}
    </>
  ) : null;

  // OpenAI-compatible connections keep an optional key behind a disclosure.
  const compatKeyBlock = isOpenAiCompatible ? (
    <div className="mt-5">
      <details className="text-[13.5px] text-muted-foreground">
        <summary className="w-fit cursor-pointer select-none">
          <Trans>API key</Trans>
        </summary>
        <Input
          aria-label={t`API key`}
          value={apiKey}
          onChange={(event) => updateApiKey(event.target.value)}
          placeholder={credential?.hasKey ? t`Paste a replacement key` : t`Optional`}
          type="password"
          autoComplete="new-password"
          className="mt-2 h-10 text-foreground"
        />
      </details>
      <Button
        type="button"
        variant="secondary"
        className="mt-3 rounded-full"
        size="sm"
        disabled={busy || !openAiCompatibleReady}
        onClick={() => void connectKey()}
      >
        {pending === "connect" ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
      </Button>
    </div>
  ) : null;

  const saveButton =
    credential && (!isActive || thinkingDirty || usingServerCredentials) ? (
      <div className="mt-6">
        <Button
          type="button"
          variant="secondary"
          className="rounded-full"
          size="sm"
          disabled={busy || (isOpenAiCompatible && !modelId.trim())}
          onClick={() => void setModelDefault()}
        >
          {pending === "default" ? (
            <Trans>Switching…</Trans>
          ) : isActive && !usingServerCredentials ? (
            <Trans>Save</Trans>
          ) : (
            <Trans>Use this model</Trans>
          )}
        </Button>
      </div>
    ) : null;

  const description = loading ? (
    <Trans>Loading model catalog…</Trans>
  ) : localOwner ? (
    <Trans>Models for the server owner’s default space.</Trans>
  ) : (
    <Trans>Choose which connected model Rakazo uses.</Trans>
  );

  const body = (
    <>
      {!embedded ? (
        <DialogHeader className="flex-row items-start justify-between px-6 pt-6 sm:px-8 sm:pt-7">
          <div>
            <DialogTitle className="text-2xl text-foreground">
              <Trans>Models</Trans>
            </DialogTitle>
            <DialogDescription className="mt-1 text-[13.5px] text-muted-foreground/70">
              {description}
            </DialogDescription>
          </div>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close model settings`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>
      ) : (
        <p className="px-6 pt-1 text-[13.5px] text-muted-foreground/70 sm:px-8">{description}</p>
      )}

      <div className={`mx-6 sm:mx-8 ${embedded ? "mt-4" : "mt-5"}`}>
        <div className="flex items-baseline gap-3">
          <span className="shrink-0 text-[12.5px] uppercase tracking-[0.08em] text-muted-foreground/80">
            <Trans>Active model</Trans>
          </span>
          <span className="truncate text-[15px] text-foreground">
            {currentEntry?.label ?? me?.defaultModel ?? t`Deployment default`}
          </span>
          <span className="truncate text-[13px] text-muted-foreground">
            {currentEntry?.providerName ?? me?.defaultProvider ?? (
              <Trans>Configured by deployment</Trans>
            )}
          </span>
          {activeThinkingLabel ? (
            <span className="shrink-0 text-[13px] text-muted-foreground">
              <Trans>Thinking: {activeThinkingLabel}</Trans>
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden px-6 py-6 sm:px-8 md:flex-row">
        <div className="flex min-h-0 shrink-0 flex-col md:w-[310px]">
          <div className="mb-3 text-[13.5px] text-muted-foreground">
            <Trans>Providers</Trans>
          </div>
          <label className="sr-only" htmlFor="model-provider-search">
            <Trans>Search providers</Trans>
          </label>
          <Input
            id="model-provider-search"
            value={providerQuery}
            onChange={(event) => setProviderQuery(event.target.value)}
            placeholder={t`Search providers`}
            className="h-10 rounded-xl px-3.5"
          />
          <div className="rk-scroll mt-3 max-h-[240px] overflow-y-auto rounded-xl border border-border md:min-h-0 md:max-h-none md:flex-1">
            {filteredGroups.length ? (
              <>
                {connectedGroups.length ? (
                  <>
                    <p className="border-b border-border px-3.5 pb-1.5 pt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
                      <Trans>Connected</Trans>
                    </p>
                    {connectedGroups.map((group) => renderProviderRow(group, true))}
                    {otherGroups.length ? (
                      <p className="border-b border-border px-3.5 pb-1.5 pt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
                        <Trans>All providers</Trans>
                      </p>
                    ) : null}
                  </>
                ) : null}
                {otherGroups.map((group) => renderProviderRow(group, false))}
              </>
            ) : (
              <p className="px-3.5 py-4 text-[13px] text-muted-foreground">
                <Trans>No providers found.</Trans>
              </p>
            )}
          </div>
        </div>

        <div ref={detailScrollRef} className="rk-scroll min-h-0 min-w-0 flex-1 overflow-y-auto">
          {error ? (
            <p className="mb-4 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="mb-4 text-sm text-success" role="status">
              {notice}
            </p>
          ) : null}
          {selected ? (
            <>
              {isOpenAiCompatible ? (
                <div className="block text-[13.5px] text-muted-foreground">
                  <label className="block" htmlFor="model-base-url">
                    <Trans>Server URL</Trans>
                    <Input
                      id="model-base-url"
                      value={baseUrl}
                      onChange={(event) => updateBaseUrl(event.target.value)}
                      aria-label={t`OpenAI-compatible server URL`}
                      placeholder="http://127.0.0.1:8000/v1"
                      autoComplete="off"
                      className="mt-2 h-10 text-foreground"
                    />
                  </label>
                  <details className="mt-2 text-[13px] leading-[1.5] text-muted-foreground">
                    <summary className="w-fit cursor-pointer select-none">
                      <Trans>Setup help</Trans>
                    </summary>
                    <p className="mt-1">
                      {t`Paste the OpenAI-compatible address from your server. Rakazo adds /v1 if needed.`}
                    </p>
                  </details>
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy || probing || !effectiveBaseUrl}
                      onClick={() => void probeServerModels()}
                    >
                      {probing ? <Trans>Finding…</Trans> : <Trans>Find models</Trans>}
                    </Button>
                  </div>
                  {preflightTarget === "compatible" ? (
                    <ModelPreflightFeedback success={null} failure={preflightFailure} />
                  ) : null}
                  <div className="mt-4 block">
                    <span>
                      <Trans>Model</Trans>
                    </span>
                    {probeModels.length && probeModels.includes(modelId) ? (
                      <NativeSelect
                        className="mt-2 w-full text-foreground"
                        value={modelId}
                        onChange={(event) => {
                          cancelOAuthAttempt();
                          selectionRevisionRef.current += 1;
                          invalidatePreflight();
                          stageCompatibleModelId(event.target.value);
                          setError(null);
                          setNotice(null);
                        }}
                        aria-label={t`Models from server`}
                      >
                        {probeModels.map((id) => (
                          <NativeSelectOption key={id} value={id}>
                            {id}
                          </NativeSelectOption>
                        ))}
                        <NativeSelectOption value="">
                          <Trans>Other model…</Trans>
                        </NativeSelectOption>
                      </NativeSelect>
                    ) : (
                      <Input
                        value={modelId}
                        onChange={(event) => {
                          cancelOAuthAttempt();
                          selectionRevisionRef.current += 1;
                          invalidatePreflight();
                          stageCompatibleModelId(event.target.value);
                          setError(null);
                          setNotice(null);
                        }}
                        aria-label={t`Model id`}
                        placeholder="exact-model-id"
                        className="mt-2 h-10 text-foreground"
                      />
                    )}
                    {probeModels.length && !probeModels.includes(modelId) ? (
                      <Button
                        type="button"
                        variant="link"
                        className="mt-2 h-auto px-0 text-[13px] text-muted-foreground underline"
                        onClick={() => {
                          invalidatePreflight();
                          stageCompatibleModelId(probeModels[0] ?? "");
                        }}
                      >
                        <Trans>Use a found model</Trans>
                      </Button>
                    ) : null}
                  </div>
                  <ModelThinkingOptions
                    reasoning={reasoning}
                    onReasoningChange={(value) => {
                      selectionRevisionRef.current += 1;
                      setReasoning(value);
                      if (!value) setThinkingLevel(null);
                      setNotice(null);
                    }}
                    disabled={busy}
                    advancedLabel={t`Advanced`}
                    thinkingLabel={t`Supports thinking`}
                    thinkingLevel={thinkingLevel}
                    onThinkingLevelChange={(value) => {
                      selectionRevisionRef.current += 1;
                      setThinkingLevel(value as ThinkingLevel | null);
                      setNotice(null);
                    }}
                    thinkingLevelOptions={[
                      { value: "minimal", label: t`Minimal` },
                      { value: "low", label: t`Low` },
                      { value: "medium", label: t`Medium` },
                      { value: "high", label: t`High` },
                      { value: "xhigh", label: t`Extra high` },
                      { value: "max", label: t`Max` },
                    ]}
                    thinkingLevelLabel={t`Reasoning effort`}
                    thinkingLevelDefaultLabel={t`Default`}
                    maxTokens={maxTokens}
                    onMaxTokensChange={(value) => {
                      selectionRevisionRef.current += 1;
                      setMaxTokens(value);
                      setNotice(null);
                    }}
                    maxTokensLabel={t`Maximum output tokens`}
                    contextWindow={contextWindow}
                    onContextWindowChange={(value) => {
                      selectionRevisionRef.current += 1;
                      setContextWindow(value);
                      setNotice(null);
                    }}
                    contextWindowLabel={t`Context limit`}
                    supportsImages={supportsImages}
                    onSupportsImagesChange={(value) => {
                      selectionRevisionRef.current += 1;
                      setSupportsImages(value);
                      setNotice(null);
                    }}
                    imagesLabel={t`Supports images`}
                    maxImagesPerPrompt={maxImagesPerPrompt}
                    onMaxImagesPerPromptChange={(value) => {
                      selectionRevisionRef.current += 1;
                      setMaxImagesPerPrompt(value);
                      setNotice(null);
                    }}
                    maxImagesLabel={t`Maximum images per request`}
                  />
                </div>
              ) : null}
              {isOpenAiCompatible ? (
                <>
                  {compatKeyBlock}
                  {saveButton}
                </>
              ) : credential ? (
                <>
                  {/* The key may be the default in another space while this one runs on server
                      credentials; saving here switches this space to the key. */}
                  {provider === me?.hostCredentialProvider ? (
                    <div className="mb-5">{serverCredentialsNote}</div>
                  ) : null}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[15px] text-foreground">
                        <Trans>Connected · {credential.label}</Trans>
                      </div>
                      <div className="mt-0.5 text-[13px] text-muted-foreground">
                        <Trans>Stored securely. Never shown here.</Trans>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="-mr-2 shrink-0 text-muted-foreground"
                      disabled={busy}
                      onClick={() => setConfirmDisconnect(true)}
                    >
                      {pending === "disconnect" ? (
                        <Trans>Disconnecting…</Trans>
                      ) : (
                        <Trans>Disconnect</Trans>
                      )}
                    </Button>
                  </div>
                  <div className="mt-5">{catalogModelConfig}</div>
                  {saveButton}
                  <div className="mt-6 border-t border-border pt-5">{connectionControls}</div>
                </>
              ) : provider === me?.hostCredentialProvider ? (
                <>
                  {serverCredentialsNote}
                  <details
                    className="mt-5 text-sm text-muted-foreground"
                    open={ownKeyProvider === provider}
                    onToggle={(event) =>
                      setOwnKeyProvider(event.currentTarget.open ? provider : null)
                    }
                  >
                    <summary className="w-fit cursor-pointer select-none">
                      <Trans>Use your own key</Trans>
                    </summary>
                    <div className="mt-5">{connectionControls}</div>
                    <div className="mt-6">{catalogModelConfig}</div>
                  </details>
                </>
              ) : (
                <>
                  <p className="text-sm leading-[1.5] text-muted-foreground">
                    <Trans>Connect this provider to use it as your personal model.</Trans>
                  </p>
                  {connectionControls}
                  <div className="mt-6">{catalogModelConfig}</div>
                </>
              )}
            </>
          ) : loading ? (
            <p className="text-muted-foreground">
              <Trans>Loading model catalog…</Trans>
            </p>
          ) : (
            <p className="text-muted-foreground">
              <Trans>No model catalog is available.</Trans>
            </p>
          )}
          {me ? (
            <ModelBackupsSettings
              userId={me.userId}
              spaceId={me.spaceId}
              catalog={catalog}
              credentials={credentials}
            />
          ) : null}
        </div>
      </div>
      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Disconnect {disconnectName}?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>This removes the connection from every space.</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending === "disconnect"}
              onClick={() => {
                setConfirmDisconnect(false);
                void disconnectCredential();
              }}
            >
              <Trans>Disconnect</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

  if (embedded) {
    return (
      <div data-testid="model-settings" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {body}
      </div>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[760px] max-h-[calc(100%-2rem)] w-[1080px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-card p-0 sm:max-w-[1080px]"
      >
        {body}
      </DialogContent>
    </Dialog>
  );
}

function ModelPicker({
  options,
  value,
  onChange,
}: {
  options: ModelCatalogEntry[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useLingui();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.id === value),
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(selectedIndex);
  const filteredOptions = useMemo(() => filterModelCatalog(options, query), [options, query]);
  const groups = useMemo(() => {
    const grouped = new Map<string, ModelCatalogEntry[]>();
    for (const option of filteredOptions) {
      const key = option.providerName ?? option.provider;
      const list = grouped.get(key);
      if (list) list.push(option);
      else grouped.set(key, [option]);
    }
    return [...grouped].map(([name, entries]) => ({ name, entries }));
  }, [filteredOptions]);
  const groupRanges = useMemo(() => {
    let index = 0;
    return groups.map((group) => {
      const start = index;
      index += group.entries.length;
      return { name: group.name, start, entries: group.entries };
    });
  }, [groups]);

  useEffect(() => {
    setHighlightedIndex(selectedIndex);
    setOpen(false);
  }, [selectedIndex, value]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  function choose(index: number) {
    const option = filteredOptions[index];
    if (!option) return;
    onChange(option.id);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveHighlight(index: number) {
    const count = filteredOptions.length;
    if (count === 0) return;
    const next = ((index % count) + count) % count;
    setHighlightedIndex(next);
    const option = optionRefs.current[next];
    option?.scrollIntoView({ block: "nearest" });
    // Keep typing focus on the search field; only follow highlight when an option
    // already has focus (e.g. after Tab / prior option key nav).
    if (document.activeElement !== searchRef.current) {
      option?.focus();
    }
  }

  function activeOptionIndex() {
    return highlightedIndex >= 0 && highlightedIndex < filteredOptions.length
      ? highlightedIndex
      : 0;
  }

  function optionDomId(index: number) {
    return `${listboxId}-option-${index}`;
  }

  const activeDescendantId =
    filteredOptions.length > 0 ? optionDomId(activeOptionIndex()) : undefined;

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filteredOptions.length === 0) return;
      moveHighlight(activeOptionIndex() + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filteredOptions.length === 0) return;
      moveHighlight(activeOptionIndex() - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      if (filteredOptions.length === 0) return;
      moveHighlight(0);
    } else if (event.key === "End") {
      event.preventDefault();
      if (filteredOptions.length === 0) return;
      moveHighlight(filteredOptions.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (filteredOptions.length === 0) return;
      choose(activeOptionIndex());
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setHighlightedIndex(Math.max(0, filteredOptions.length - 1));
    }
  }

  function onOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveHighlight(0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveHighlight(filteredOptions.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(index);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  return (
    <div ref={rootRef} className="relative mt-2">
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={t`Model`}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex h-10 w-full items-center justify-between rounded-lg border border-input bg-transparent px-3 text-start text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="min-w-0 truncate">{options[selectedIndex]?.label}</span>
        <span className="ml-3 shrink-0 text-muted-foreground" aria-hidden="true">
          <ChevronDown size={16} strokeWidth={1.8} />
        </span>
      </button>
      {open ? (
        <div className="absolute left-0 right-0 top-full z-20 mt-2 overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10">
          <input
            ref={searchRef}
            type="text"
            value={query}
            role="combobox"
            aria-label={t`Search models`}
            aria-controls={listboxId}
            aria-expanded={open}
            aria-autocomplete="list"
            aria-activedescendant={activeDescendantId}
            placeholder={t`Search`}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlightedIndex(0);
            }}
            onKeyDown={onSearchKeyDown}
            className="w-full border-b border-border bg-transparent px-3 py-2.5 text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground/80"
          />
          <div
            id={listboxId}
            role="listbox"
            aria-label={t`Model options`}
            className="rk-scroll max-h-64 overflow-y-auto py-1"
          >
            {groupRanges.map((group) => (
              <div key={group.name}>
                {groupRanges.length > 1 ? (
                  <p className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
                    {group.name}
                  </p>
                ) : null}
                {group.entries.map((option, groupIndex) => {
                  const index = group.start + groupIndex;
                  return (
                    <ModelOption
                      key={`${option.provider}:${option.id}`}
                      option={option}
                      optionDomId={optionDomId(index)}
                      index={index}
                      value={value}
                      highlighted={highlightedIndex === index}
                      optionRefs={optionRefs}
                      choose={choose}
                      onOptionKeyDown={onOptionKeyDown}
                    />
                  );
                })}
              </div>
            ))}
            {filteredOptions.length === 0 ? (
              <p className="px-3 py-2 text-[13px] text-muted-foreground">
                <Trans>No matching models</Trans>
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ModelOption({
  option,
  optionDomId,
  index,
  value,
  highlighted,
  optionRefs,
  choose,
  onOptionKeyDown,
}: {
  option: ModelCatalogEntry;
  optionDomId: string;
  index: number;
  value: string;
  highlighted: boolean;
  optionRefs: RefObject<Array<HTMLButtonElement | null>>;
  choose: (index: number) => void;
  onOptionKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => void;
}) {
  const { t } = useLingui();
  return (
    <button
      id={optionDomId}
      ref={(element) => {
        optionRefs.current[index] = element;
      }}
      type="button"
      role="option"
      aria-selected={option.id === value}
      tabIndex={highlighted ? 0 : -1}
      className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-start text-[13.5px] text-foreground outline-none hover:bg-accent focus-visible:bg-accent ${
        highlighted ? "bg-accent" : ""
      }`}
      onClick={() => choose(index)}
      onKeyDown={(event) => onOptionKeyDown(event, index)}
    >
      <span className="min-w-0 truncate">{option.label}</span>
      <span className="flex shrink-0 items-center gap-2 text-[12px] text-muted-foreground">
        {option.billing.toLowerCase().includes("free") ? t`Free` : null}
        {option.id === value ? (
          <Check size={14} strokeWidth={2} className="text-foreground" aria-hidden="true" />
        ) : null}
      </span>
    </button>
  );
}
