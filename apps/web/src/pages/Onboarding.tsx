import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { ModelHeaderRow, ThinkingLevel } from "@rakazo/contracts";
import {
  CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
  cloudflareModelRouting,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  isCloudflareModelProvider,
  isOllamaCloudBaseUrl,
  MAX_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_MAX_TOKENS,
  ModelHeaderRowsSchema,
  modelHeadersInput,
  OLLAMA_CLOUD_BASE_URL,
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
  initialModelProbeState,
  pickCatalogModelId,
  popularModelProvidersFirst,
} from "@rakazo/core";
import {
  Button,
  Input,
  ModelThinkingOptions,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@rakazo/ui-web";
import { Check, Copy } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ModelPreflightFeedback,
  modelPreflightTestingLabel,
} from "../components/ModelConnectionPreflightNotice";
import { ModelHeadersEditor } from "../components/ModelHeadersEditor";
import { PageLoading } from "../components/PageLoading";
import { SignupSurvey } from "../components/SignupSurvey";
import { useCopyText } from "../lib/copy-text";
import { providerDisplayName } from "../lib/localized-provider-hint";
import type { ModelCatalogEntry } from "../lib/model-auth";
import type { ModelPreflightFailure } from "../lib/model-connection-preflight";
import {
  classifyModelConnectionFailure,
  modelPreflightSuccessMessage,
  runModelConnectionPreflight,
  unavailableSelectedModel,
} from "../lib/model-connection-preflight";
import { rpc } from "../lib/rpc";
import { useModelOAuthSignIn } from "../lib/use-model-oauth-signin";
import { errorText } from "../lib/user-error";
import { CompatibleKeyField } from "./model-settings/compatible-key-field";

const CUSTOM_MODEL_OPTION = "__rakazo_custom_model__";
/** Rakazo credits sit among the providers as the one choice that needs no account of its own. */
const CREDITS_OPTION = "__rakazo_credits__";
/** A provider whose catalog entry offers both sign-in and a key appears once per way to connect. */
type ProviderAuth = "sign-in" | "key";

const MAIN_PROVIDER_OPTIONS: ReadonlyArray<{ provider: string; auth?: ProviderAuth }> = [
  { provider: "openai-codex" },
  { provider: "anthropic", auth: "sign-in" },
  { provider: "openai" },
  { provider: "anthropic", auth: "key" },
  { provider: "openrouter" },
  { provider: "google" },
];

function providerOptionValue(provider: string, auth?: ProviderAuth): string {
  return auth ? `${provider}:${auth}` : provider;
}
const FIRST_BOT_NAME = "Chief";
const FIRST_BOT_SPAWN_KEY = "onboarding:first";
const FIRST_BOT_LOCK = "rakazo:onboarding-first-bot";

/** Survives StrictMode remounts; concurrent first-bot creates share one in-flight attempt. */
let firstBotEnsure: Promise<{ id: string }> | null = null;

function findFirstBot(
  bots: Array<{ id: string; name: string; spawnKey: string | null }>,
): { id: string } | undefined {
  const bySpawnKey = bots.find((bot) => bot.spawnKey === FIRST_BOT_SPAWN_KEY);
  if (bySpawnKey) return { id: bySpawnKey.id };
  // Legacy first-run Chief created before spawnKey was set.
  const byName = bots.find((bot) => bot.name === FIRST_BOT_NAME);
  return byName ? { id: byName.id } : undefined;
}

async function createOrReuseFirstBot(): Promise<{ id: string }> {
  const existing = await rpc.bots.list();
  const reuse = findFirstBot(existing);
  if (reuse) return reuse;
  try {
    const created = await rpc.bots.create({
      name: FIRST_BOT_NAME,
      description: "",
      instructions: "",
      notifyOnFinish: true,
      spawnKey: FIRST_BOT_SPAWN_KEY,
    });
    return { id: created.id };
  } catch (error) {
    // Another tab won the unique (spaceId, spawnKey) race; reuse that bot only.
    const afterConflict = await rpc.bots.list();
    const winner = afterConflict.find((bot) => bot.spawnKey === FIRST_BOT_SPAWN_KEY);
    if (winner) return { id: winner.id };
    throw error;
  }
}

async function withFirstBotLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return run();
  return locks.request(FIRST_BOT_LOCK, run);
}

async function ensureFirstBot(): Promise<{ id: string }> {
  if (firstBotEnsure) return firstBotEnsure;
  // Web Lock serializes cross-tab creates; module promise covers same-tab StrictMode.
  // spawnKey makes create idempotent when locks are unavailable.
  // Clear after settle so a later empty-space visit re-lists instead of reusing a deleted id.
  firstBotEnsure = withFirstBotLock(createOrReuseFirstBot).finally(() => {
    firstBotEnsure = null;
  });
  return firstBotEnsure;
}

export function OnboardingPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const fieldId = useId();
  // The URL holds the survey and model steps, so /onboarding/survey and /onboarding/model open directly.
  const { step: routeStep } = useParams();
  const linkedStep = routeStep === "survey" || routeStep === "model" ? routeStep : undefined;
  const [creatingBot, setCreatingBot] = useState(false);
  const [surveyDone, setSurveyDone] = useState(false);
  const step = creatingBot ? "bot" : surveyDone ? "loading" : (linkedStep ?? "loading");
  const [billingEnabled, setBillingEnabled] = useState(false);
  // The step after the survey; null until me loads.
  const [afterSurvey, setAfterSurvey] = useState<"model" | "bot" | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [provider, setProvider] = useState("");
  const [providerAuth, setProviderAuth] = useState<ProviderAuth | undefined>();
  const [credits, setCredits] = useState(false);
  const [modelId, setModelId] = useState("");
  const modelIdRef = useRef(modelId);
  modelIdRef.current = modelId;
  const [apiKey, setApiKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [gatewayId, setGatewayId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [headerRows, setHeaderRows] = useState<ModelHeaderRow[] | null>(null);
  const [reasoning, setReasoning] = useState(false);
  const [manualModelId, setManualModelId] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | null>(null);
  const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MODEL_MAX_TOKENS));
  const [contextWindow, setContextWindow] = useState(String(DEFAULT_MODEL_CONTEXT_WINDOW));
  const [supportsImages, setSupportsImages] = useState(false);
  const [maxImagesPerPrompt, setMaxImagesPerPrompt] = useState("");
  const [{ models: probeModels, probing }, setProbe] = useState(initialModelProbeState);
  const [modelProbe] = useState(() => createModelProbe(setProbe));
  const resetOpenAiCompatibleProbe = modelProbe.reset;
  const createStartedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preflightTesting, setPreflightTesting] = useState(false);
  const [preflightTarget, setPreflightTarget] = useState<"api-key" | "compatible" | null>(null);
  const [preflightSuccess, setPreflightSuccess] = useState<string | null>(null);
  const [preflightFailure, setPreflightFailure] = useState<ModelPreflightFailure | null>(null);
  const preflightRevisionRef = useRef(0);
  const [codeCopied, copyOAuthCode] = useCopyText();

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
      goTo("bot");
    },
  });

  useEffect(() => {
    void Promise.all([rpc.me(), rpc.models.list().catch(() => [])])
      .then(([me, models]) => {
        setBillingEnabled(me.billingEnabled);
        setCatalog(models);
        const next = me.needsModel ? "model" : "bot";
        setAfterSurvey(next);
        if (!linkedStep) goTo(me.needsSignupSurvey ? "survey" : next);
      })
      .catch(() => {
        setAfterSurvey("bot");
        if (!linkedStep) goTo("bot");
      });
    return () => {
      modelProbe.invalidate();
    };
  }, []);

  useEffect(() => {
    if (!surveyDone || !afterSurvey) return;
    setSurveyDone(false);
    goTo(afterSurvey);
  }, [surveyDone, afterSurvey]);

  function goTo(next: "survey" | "model" | "bot") {
    if (next === "bot") setCreatingBot(true);
    navigate(next === "bot" ? "/onboarding" : `/onboarding/${next}`, { replace: true });
  }

  const providers = useMemo(() => {
    const seen = new Map<string, ModelCatalogEntry>();
    for (const entry of catalog) {
      if (!seen.has(entry.provider)) seen.set(entry.provider, entry);
    }
    return popularModelProvidersFirst([...seen.values()], (entry) => entry.provider);
  }, [catalog]);

  const modelsForProvider = useMemo(
    () => catalog.filter((entry) => entry.provider === provider),
    [catalog, provider],
  );

  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  const isOpenAiCompatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const isCloudflareGateway = provider === CLOUDFLARE_AI_GATEWAY_PROVIDER_ID;
  const isCloudflare = isCloudflareModelProvider(provider);
  const cloudflareRoutingReady =
    !isCloudflare || cloudflareModelRouting({ provider, accountId, gatewayId }) !== undefined;
  const subscriptionSignIn = selected?.signIn !== undefined && providerAuth !== "key";
  const acceptsKey = selected?.auth !== "oauth" && providerAuth !== "sign-in";
  const signInLabel = selected?.oauthLabel ?? t`Sign in`;
  const openAiCompatibleReady = openAiCompatibleConnectReady({
    apiKey,
    baseUrl,
    modelId:
      headerRows !== null && !ModelHeaderRowsSchema.safeParse(headerRows).success ? "" : modelId,
  });
  const canSaveModel = Boolean(
    selected &&
      modelId.trim() &&
      !oauthPending &&
      cloudflareRoutingReady &&
      (isOpenAiCompatible ? openAiCompatibleReady : acceptsKey && apiKey.trim()),
  );
  const otherModelLabel = t`Other model…`;
  // Subscriptions and the common API providers first; every other provider follows.
  const providerOptions = useMemo(() => {
    const byId = new Map(providers.map((entry) => [entry.provider, entry]));
    // Beside the subscriptions, the key-based options say API.
    const optionLabel = (id: string, auth?: ProviderAuth) => {
      if (id === "anthropic" && auth === "key") return t`Anthropic API`;
      if (id === "openai") return t`OpenAI API`;
      return providerDisplayName(id, byId.get(id)?.providerName ?? id, auth);
    };
    const main = [
      ...(billingEnabled ? [{ value: CREDITS_OPTION, label: t`Rakazo credits` }] : []),
      ...MAIN_PROVIDER_OPTIONS.filter((option) => byId.has(option.provider)).map((option) => ({
        value: providerOptionValue(option.provider, option.auth),
        label: optionLabel(option.provider, option.auth),
      })),
    ];
    const rest = providers
      .filter(
        (entry) => !MAIN_PROVIDER_OPTIONS.some((option) => option.provider === entry.provider),
      )
      .flatMap((entry) => {
        const item = { value: entry.provider, label: entry.providerName ?? entry.provider };
        return entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID
          ? [item, { value: "ollama-preset", label: t`Ollama Cloud` }]
          : [item];
      });
    return { main, rest };
  }, [billingEnabled, providers, t]);
  // Base UI Select.Value only resolves labels when Root gets `items`.
  const providerItems = useMemo(
    () => [...providerOptions.main, ...providerOptions.rest],
    [providerOptions],
  );
  const modelItems = useMemo(
    () => modelsForProvider.map((entry) => ({ value: entry.id, label: entry.label })),
    [modelsForProvider],
  );
  const probeModelItems = useMemo(
    () => [
      ...probeModels.map((id) => ({ value: id, label: id })),
      { value: CUSTOM_MODEL_OPTION, label: otherModelLabel },
    ],
    [otherModelLabel, probeModels],
  );

  function invalidatePreflight() {
    preflightRevisionRef.current += 1;
    setPreflightTesting(false);
    setPreflightTarget(null);
    setPreflightSuccess(null);
    setPreflightFailure(null);
  }

  function updateBaseUrl(nextBaseUrl: string) {
    setBaseUrl(nextBaseUrl);
    setHeaderRows(null);
    // Keep Other model… mode across URL edits; only provider change clears it.
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

  function selectProvider(option: string, presetBaseUrl?: string) {
    if (
      option === providerOptionValue(provider, providerAuth) &&
      !presetBaseUrl &&
      !isOllamaCloudBaseUrl(baseUrl)
    )
      return;
    const [nextProvider = option, auth] = option.split(":") as [string, ProviderAuth?];
    cancelOAuthAttempt();
    setProvider(nextProvider);
    setProviderAuth(auth);
    setApiKey("");
    setHeaderRows(null);
    setAccountId("");
    setGatewayId("");
    setModelId(
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? ""
        : pickCatalogModelId(catalog, nextProvider),
    );
    setBaseUrl(presetBaseUrl ?? "");
    setReasoning(false);
    setThinkingLevel(null);
    setManualModelId(false);
    setSupportsImages(false);
    setMaxTokens(String(DEFAULT_MODEL_MAX_TOKENS));
    setContextWindow(String(DEFAULT_MODEL_CONTEXT_WINDOW));
    setMaxImagesPerPrompt("");
    resetOpenAiCompatibleProbe();
    invalidatePreflight();
    setError(null);
    setNotice(null);
  }

  function preflightStillCurrent(revision: number): boolean {
    return revision === preflightRevisionRef.current;
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
        rpc.models.probeOpenAiCompatible({ ...input, headers: modelHeadersInput(headerRows) }),
      onSuccess: (models) => {
        if (!preflightStillCurrent(revision)) return;
        const trimmed = modelIdRef.current.trim();
        const next = trimmed || models[0] || "";
        if (next !== trimmed) setThinkingLevel(null);
        // Stay in manual entry across re-probes so a typed id that matches a
        // discovered model cannot yank the freeform field back to the Select.
        setManualModelId(
          (wasManual) => wasManual || (Boolean(trimmed) && !models.includes(trimmed)),
        );
        setModelId(next);
        const unavailable = unavailableSelectedModel(trimmed, models);
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

  function stagedThinkingLevel(): ThinkingLevel | null {
    return clampCatalogThinkingLevel(
      thinkingLevel,
      reasoning ? COMPATIBLE_THINKING_LEVELS : [],
    ) as ThinkingLevel | null;
  }

  async function saveModel() {
    if (!canSaveModel) return;
    setError(null);
    try {
      if (isOpenAiCompatible) {
        const parsedMaxImagesPerPrompt = parseModelMaxImagesPerPrompt(
          maxImagesPerPrompt,
          supportsImages,
        );
        if (supportsImages && maxImagesPerPrompt.trim() && parsedMaxImagesPerPrompt === undefined) {
          setError(t`Enter a whole number from 1 to 1000 for the image limit.`);
          return;
        }
        const maxImagesPerPromptInput =
          supportsImages && !maxImagesPerPrompt.trim() ? null : parsedMaxImagesPerPrompt;

        const parsedMaxTokens = parseModelMaxTokens(maxTokens);
        if (parsedMaxTokens === undefined) {
          setError(
            t`Enter a whole number from 1 to ${MAX_MODEL_MAX_TOKENS} for maximum output tokens.`,
          );
          return;
        }
        const parsedContextWindow = parseModelContextWindow(contextWindow);
        if (parsedContextWindow === undefined) {
          setError(
            t`Enter a whole number from 1 to ${MAX_MODEL_CONTEXT_WINDOW} for the context limit.`,
          );
          return;
        }
        await rpc.models.connect({
          provider,
          baseUrl: baseUrl.trim(),
          headers: modelHeadersInput(headerRows),
          modelId: modelId.trim(),
          reasoning,
          thinkingLevel: stagedThinkingLevel(),
          maxTokens: parsedMaxTokens,
          contextWindow: parsedContextWindow,
          supportsImages,
          maxImagesPerPrompt: maxImagesPerPromptInput,
          apiKey: apiKey.trim() || undefined,
          label: selected?.providerName ?? provider,
        });
      } else if (apiKey) {
        await rpc.models.connect({
          provider,
          apiKey,
          ...(isCloudflare ? { accountId: accountId.trim(), gatewayId: gatewayId.trim() } : {}),
          modelId,
          label: selected?.providerName ?? provider,
        });
      }
      goTo("bot");
    } catch (err) {
      setError(errorText(err, t`Could not save model`));
    }
  }

  async function fundWithCredits() {
    setError(null);
    try {
      await rpc.billing.selectFunding({ funding: "credits" });
      window.location.assign("/onboarding");
    } catch {
      setError(t`Could not open billing`);
    }
  }

  function beginSelectedSubscriptionSignIn() {
    if (!selected?.id) return;
    void startSubscriptionSignIn({
      provider: selected.provider,
      modelId: selected.id,
      label: selected.providerName ?? selected.provider,
    });
  }

  async function createFirstBot() {
    if (createStartedRef.current) return;
    createStartedRef.current = true;
    setError(null);
    try {
      const bot = await ensureFirstBot();
      // Onboarding continues conversationally in the thread: greeting first,
      // then the focus choice (immediate for the first bot).
      const started = await rpc.onboarding
        .start({ botId: bot.id })
        .then(() => true)
        .catch(() => false);
      if (started) {
        await rpc.onboarding.promptFocus({ botId: bot.id }).catch(() => undefined);
      }
      navigate(`/app/${bot.id}`);
    } catch (err) {
      createStartedRef.current = false;
      setError(errorText(err, t`Could not create your bot`));
    }
  }

  useEffect(() => {
    if (step !== "bot") return;
    void createFirstBot();
  }, [step]);

  // Loading, and creating the first bot, both wait on one spinner until the chat opens.
  if (step === "loading" || (step === "bot" && !error)) return <PageLoading />;

  return (
    <div className="min-h-full bg-background px-6 py-12" data-rakazo-surface="onboarding">
      <div className="mx-auto w-full max-w-[560px]">
        {step === "survey" ? <SignupSurvey onDone={() => setSurveyDone(true)} /> : null}
        {step === "model" ? (
          <div>
            <h1 className="text-[32px] font-medium text-foreground">
              <Trans>Connect a model</Trans>
            </h1>
            <div className="mt-8 block text-sm font-medium text-foreground">
              <span>
                <Trans>Provider</Trans>
              </span>
              <Select
                value={
                  credits
                    ? CREDITS_OPTION
                    : isOpenAiCompatible && isOllamaCloudBaseUrl(baseUrl)
                      ? "ollama-preset"
                      : provider
                        ? providerOptionValue(provider, providerAuth)
                        : null
                }
                onValueChange={(value) => {
                  if (typeof value !== "string" || !value) return;
                  if (value === CREDITS_OPTION) {
                    cancelOAuthAttempt();
                    setProvider("");
                    setProviderAuth(undefined);
                    setCredits(true);
                    setError(null);
                    return;
                  }
                  setCredits(false);
                  if (value === "ollama-preset")
                    selectProvider(OPENAI_COMPATIBLE_PROVIDER_ID, OLLAMA_CLOUD_BASE_URL);
                  else selectProvider(value);
                }}
                items={providerItems}
              >
                <SelectTrigger aria-label={t`Provider`} className="mt-2 w-full">
                  <SelectValue placeholder={t`Choose a provider`} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {providerOptions.main.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  {providerOptions.main.length && providerOptions.rest.length ? (
                    <SelectSeparator />
                  ) : null}
                  <SelectGroup>
                    {providerOptions.rest.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            {provider ? (
              <>
                {isOpenAiCompatible ? (
                  <div className="mt-6 block text-sm text-foreground">
                    <label htmlFor={`${fieldId}-base-url`} className="block font-medium">
                      <Trans>Server URL</Trans>
                      <Input
                        id={`${fieldId}-base-url`}
                        value={baseUrl}
                        onChange={(e) => updateBaseUrl(e.target.value)}
                        aria-label={t`OpenAI-compatible server URL`}
                        placeholder="http://127.0.0.1:8000/v1"
                        autoComplete="off"
                        className="mt-2"
                      />
                    </label>
                    <div className="mt-3">
                      <Button
                        variant="outline"
                        disabled={probing || !baseUrl.trim()}
                        onClick={() => void probeServerModels()}
                      >
                        {probing ? <Trans>Finding…</Trans> : <Trans>Find models</Trans>}
                      </Button>
                      {preflightTarget === "compatible" ? (
                        <ModelPreflightFeedback success={null} failure={preflightFailure} />
                      ) : null}
                    </div>
                    <div className="mt-4 block">
                      <span className="font-medium">
                        <Trans>Model</Trans>
                      </span>
                      {probeModels.length && !manualModelId ? (
                        <Select
                          value={modelId}
                          onValueChange={(value) => {
                            if (typeof value !== "string") return;
                            const next = value;
                            invalidatePreflight();
                            if (next === CUSTOM_MODEL_OPTION) {
                              setManualModelId(true);
                              setModelId("");
                            } else {
                              setManualModelId(false);
                              setModelId(next);
                            }
                          }}
                          items={probeModelItems}
                        >
                          <SelectTrigger aria-label={t`Models from server`} className="mt-2 w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {probeModels.map((id) => (
                                <SelectItem key={id} value={id}>
                                  {id}
                                </SelectItem>
                              ))}
                              <SelectItem value={CUSTOM_MODEL_OPTION}>
                                <Trans>Other model…</Trans>
                              </SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          value={modelId}
                          onChange={(e) => {
                            setManualModelId(true);
                            setModelId(e.target.value);
                            invalidatePreflight();
                          }}
                          aria-label={t`Model id`}
                          placeholder="exact-model-id"
                          className="mt-2"
                        />
                      )}
                      {probeModels.length && manualModelId ? (
                        <Button
                          variant="link"
                          size="xs"
                          className="mt-2 px-0 text-muted-foreground"
                          onClick={() => {
                            setManualModelId(false);
                            setModelId(probeModels[0] ?? "");
                            invalidatePreflight();
                          }}
                        >
                          <Trans>Use a found model</Trans>
                        </Button>
                      ) : null}
                    </div>
                    <ModelThinkingOptions
                      reasoning={reasoning}
                      onReasoningChange={(value) => {
                        setReasoning(value);
                        if (!value) setThinkingLevel(null);
                      }}
                      advancedLabel={t`Advanced`}
                      thinkingLabel={t`Supports thinking`}
                      thinkingLevel={thinkingLevel}
                      onThinkingLevelChange={(value) =>
                        setThinkingLevel(value as ThinkingLevel | null)
                      }
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
                      onMaxTokensChange={setMaxTokens}
                      maxTokensLabel={t`Maximum output tokens`}
                      contextWindow={contextWindow}
                      onContextWindowChange={setContextWindow}
                      contextWindowLabel={t`Context limit`}
                      supportsImages={supportsImages}
                      onSupportsImagesChange={setSupportsImages}
                      imagesLabel={t`Supports images`}
                      maxImagesPerPrompt={maxImagesPerPrompt}
                      onMaxImagesPerPromptChange={setMaxImagesPerPrompt}
                      maxImagesLabel={t`Maximum images per request`}
                    >
                      <ModelHeadersEditor
                        rows={headerRows}
                        onChange={(rows) => {
                          setHeaderRows(rows);
                          resetOpenAiCompatibleProbe();
                          invalidatePreflight();
                        }}
                      />
                    </ModelThinkingOptions>
                  </div>
                ) : null}
                {subscriptionSignIn ? (
                  <div className="mt-4">
                    {oauth ? (
                      <div className="rounded-lg border border-border px-3.5 py-3">
                        {oauth.mode === "auth-url" ? (
                          <>
                            <p className="text-sm text-muted-foreground">
                              <Trans>
                                Sign in at{" "}
                                <a
                                  href={oauth.verificationUri}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-foreground underline"
                                >
                                  {new URL(oauth.verificationUri).hostname}
                                </a>
                                , then paste the code here.
                              </Trans>
                            </p>
                            <div className="mt-3 flex items-center gap-2">
                              <Input
                                value={pasteCode}
                                onChange={(e) => setPasteCode(e.target.value)}
                                aria-label={t`Authorization code`}
                                autoComplete="off"
                                spellCheck={false}
                              />
                              <Button
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
                            <p className="text-sm text-muted-foreground">
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
                        disabled={oauthPending}
                        onClick={() => beginSelectedSubscriptionSignIn()}
                      >
                        {oauthPending ? <Trans>Starting…</Trans> : signInLabel}
                      </Button>
                    )}
                  </div>
                ) : null}
                {isCloudflare && acceptsKey ? (
                  <div className="mt-4 grid gap-4">
                    <label
                      htmlFor={`${fieldId}-account-id`}
                      className="block text-sm font-medium text-foreground"
                    >
                      <Trans>Account ID</Trans>
                      <Input
                        id={`${fieldId}-account-id`}
                        value={accountId}
                        onChange={(event) => setAccountId(event.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        className="mt-2"
                      />
                    </label>
                    {isCloudflareGateway ? (
                      <label
                        htmlFor={`${fieldId}-gateway-id`}
                        className="block text-sm font-medium text-foreground"
                      >
                        <Trans>Gateway ID</Trans>
                        <Input
                          id={`${fieldId}-gateway-id`}
                          value={gatewayId}
                          onChange={(event) => setGatewayId(event.target.value)}
                          autoComplete="off"
                          spellCheck={false}
                          className="mt-2"
                        />
                      </label>
                    ) : null}
                  </div>
                ) : null}
                {acceptsKey ? (
                  isOpenAiCompatible ? (
                    <CompatibleKeyField
                      className="mt-4 block text-sm text-muted-foreground"
                      baseUrl={baseUrl}
                    >
                      <Input
                        aria-label={t`API key`}
                        value={apiKey}
                        onChange={(e) => updateApiKey(e.target.value)}
                        required={isOllamaCloudBaseUrl(baseUrl)}
                        placeholder={
                          isOllamaCloudBaseUrl(baseUrl) ? t`Ollama API key` : t`Optional`
                        }
                        type="password"
                        autoComplete="new-password"
                        className="mt-2"
                      />
                    </CompatibleKeyField>
                  ) : (
                    <label
                      htmlFor={`${fieldId}-api-key`}
                      className="mt-4 block text-sm font-medium text-foreground"
                    >
                      {subscriptionSignIn ? (
                        <Trans>Or paste an API key</Trans>
                      ) : (
                        <Trans>API key</Trans>
                      )}
                      <Input
                        id={`${fieldId}-api-key`}
                        value={apiKey}
                        onChange={(e) => updateApiKey(e.target.value)}
                        placeholder="sk-…"
                        type="password"
                        autoComplete="new-password"
                        className="mt-2"
                      />
                    </label>
                  )
                ) : null}
                {acceptsKey && !isOpenAiCompatible && selected?.catalogProbe ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      className="mt-3"
                      disabled={preflightTesting || apiKey.trim().length < 8}
                      onClick={() => void testApiKeyConnection()}
                    >
                      {modelPreflightTestingLabel(
                        preflightTesting && preflightTarget === "api-key",
                        "api-key",
                      )}
                    </Button>
                    {preflightTarget === "api-key" ? (
                      <ModelPreflightFeedback
                        success={preflightSuccess}
                        failure={preflightFailure}
                      />
                    ) : null}
                  </>
                ) : null}
                {/* The model is chosen once the account is connected; sign-in uses the default. */}
                {!isOpenAiCompatible && acceptsKey && apiKey.trim() ? (
                  <div className="mt-6 block text-sm text-foreground">
                    <span className="font-medium">
                      <Trans>Model</Trans>
                    </span>
                    <Select
                      value={selected?.id ?? modelId}
                      onValueChange={(value) => {
                        if (typeof value !== "string" || !value) return;
                        if (value === modelId) return;
                        cancelOAuthAttempt();
                        setModelId(value);
                        setThinkingLevel(null);
                        invalidatePreflight();
                      }}
                      items={modelItems}
                    >
                      <SelectTrigger aria-label={t`Model`} className="mt-2 w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {modelsForProvider.map((entry) => (
                            <SelectItem key={`${entry.provider}:${entry.id}`} value={entry.id}>
                              {entry.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
              </>
            ) : null}
            {notice ? (
              <p className="mt-3 text-sm text-success" role="status">
                {notice}
              </p>
            ) : null}
            {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
            <Button
              className="mt-6"
              disabled={!credits && !canSaveModel}
              onClick={() => void (credits ? fundWithCredits() : saveModel())}
            >
              <Trans>Continue</Trans>
            </Button>
          </div>
        ) : null}
        {step === "bot" ? (
          <div>
            <p className="text-sm text-destructive">{error}</p>
            <Button className="mt-4" onClick={() => void createFirstBot()}>
              <Trans>Try again</Trans>
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
