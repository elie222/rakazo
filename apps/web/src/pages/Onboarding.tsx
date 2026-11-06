import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { ThinkingLevel } from "@rakazo/contracts";
import {
  compatibleEndpointPresets,
  MAX_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_MAX_TOKENS,
  ModelHeaderRowsSchema,
  matchCompatibleEndpointPreset,
  modelHeadersInput,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleConnectReady,
  parseModelContextWindow,
  parseModelMaxImagesPerPrompt,
  parseModelMaxTokens,
} from "@rakazo/contracts";
import {
  clampCatalogThinkingLevel,
  compatibleThinkingLevels,
  connectionFormFields,
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
import { AccountMenu } from "../components/AccountMenu";
import { FoundModelPicker } from "../components/FoundModelPicker";
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
import { rpc } from "../lib/rpc";
import { useSignOut } from "../lib/sign-out";
import { useModelOAuthSignIn } from "../lib/use-model-oauth-signin";
import { errorText } from "../lib/user-error";
import { CompatibleKeyField } from "./model-settings/compatible-key-field";
import { useModelConnectionForm } from "./model-settings/use-model-connection-form";

const CUSTOM_MODEL_OPTION = "__rakazo_custom_model__";
/** Rakazo credits sit among the providers as the one choice that needs no account of its own. */
const CREDITS_OPTION = "__rakazo_credits__";
/** Select value for a hosted compatible service; the rest of the value is its base URL. */
const ENDPOINT_PRESET_OPTION = "endpoint-preset:";
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
  const [providerAuth, setProviderAuth] = useState<ProviderAuth | undefined>();
  const [credits, setCredits] = useState(false);
  const [manualModelId, setManualModelId] = useState(false);
  const {
    accountId,
    apiKey,
    apiProtocol,
    baseUrl,
    routingReady,
    contextWindow,
    error,
    gatewayId,
    headerRows,
    invalidatePreflight,
    needsRouting,
    needsGateway,
    isOpenAiCompatible,
    maxImagesPerPrompt,
    maxTokens,
    modelId,
    modelProbe,
    modelsForProvider,
    notice,
    openConnection,
    preflightFailure,
    preflightSuccess,
    preflightTarget,
    preflightTesting,
    probeModels,
    probeServerModels,
    probing,
    provider,
    reasoning,
    resetOpenAiCompatibleProbe,
    selected,
    setAccountId,
    setContextWindow,
    setError,
    setGatewayId,
    setHeaderRows,
    setMaxImagesPerPrompt,
    setMaxTokens,
    setModelId,
    setProvider,
    setReasoning,
    setSupportsImages,
    setThinkingLevel,
    supportsImages,
    testApiKeyConnection,
    thinkingLevel,
    updateApiKey,
    updateBaseUrl,
  } = useModelConnectionForm({
    rpc,
    catalog,
    // Stay in manual entry across re-probes so a typed id that matches a
    // discovered model cannot yank the freeform field back to the Select.
    onModelsFound: (models, typedModelId) =>
      setManualModelId(
        (wasManual) => wasManual || (Boolean(typedModelId) && !models.includes(typedModelId)),
      ),
  });
  const createStartedRef = useRef(false);
  const { signingOut, logOut } = useSignOut("/sign-in", setError);
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
    return popularModelProvidersFirst(
      [...seen.values()],
      (entry) => entry.provider,
      (entry) => entry.providerName ?? entry.provider,
    );
  }, [catalog]);

  const subscriptionSignIn = selected?.signIn !== undefined && providerAuth !== "key";
  const acceptsKey = selected?.auth !== "oauth" && providerAuth !== "sign-in";
  const signInLabel = selected?.oauthLabel ?? t`Sign in`;
  const endpointPresets = useMemo(() => compatibleEndpointPresets(catalog), [catalog]);
  const endpointPreset = isOpenAiCompatible
    ? matchCompatibleEndpointPreset(endpointPresets, baseUrl)
    : undefined;
  const openAiCompatibleReady = openAiCompatibleConnectReady({
    apiKey,
    baseUrl,
    modelId:
      headerRows !== null && !ModelHeaderRowsSchema.safeParse(headerRows).success ? "" : modelId,
    keyRequired: Boolean(endpointPreset),
  });
  const canSaveModel = Boolean(
    selected &&
      modelId.trim() &&
      !oauthPending &&
      routingReady &&
      (isOpenAiCompatible ? openAiCompatibleReady : acceptsKey && apiKey.trim()),
  );
  // Subscriptions and the common API providers first; every other provider follows by name.
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
    const rest = popularModelProvidersFirst(
      providers
        .filter(
          (entry) => !MAIN_PROVIDER_OPTIONS.some((option) => option.provider === entry.provider),
        )
        .flatMap((entry) => {
          const item = { value: entry.provider, label: entry.providerName ?? entry.provider };
          return [
            item,
            ...(entry.endpointPresets ?? []).map((preset) => ({
              value: `${ENDPOINT_PRESET_OPTION}${preset.baseUrl}`,
              label: preset.name,
            })),
          ];
        }),
      (option) => option.value,
      (option) => option.label,
    );
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

  function selectProvider(option: string, presetBaseUrl?: string) {
    if (option === providerOptionValue(provider, providerAuth) && !presetBaseUrl && !endpointPreset)
      return;
    const [nextProvider = option, auth] = option.split(":") as [string, ProviderAuth?];
    cancelOAuthAttempt();
    setProviderAuth(auth);
    setManualModelId(false);
    const nextModelId =
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? ""
        : pickCatalogModelId(catalog, nextProvider);
    openConnection(
      nextProvider,
      nextModelId,
      connectionFormFields({
        catalog,
        provider: nextProvider,
        modelId: nextModelId,
        presetBaseUrl,
      }),
    );
  }

  function stagedThinkingLevel(): ThinkingLevel | null {
    return clampCatalogThinkingLevel(
      thinkingLevel,
      reasoning ? compatibleThinkingLevels(apiProtocol) : [],
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
          apiProtocol,
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
          ...(needsRouting ? { accountId: accountId.trim(), gatewayId: gatewayId.trim() } : {}),
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
      <AccountMenu signingOut={signingOut} onLogOut={() => void logOut()} />
      <div className="mx-auto w-full max-w-[560px]">
        {step === "survey" ? <SignupSurvey onDone={() => setSurveyDone(true)} /> : null}
        {step === "model" ? (
          <div>
            <h1 className="text-display font-medium text-foreground">
              <Trans>Connect a model</Trans>
            </h1>
            <div className="mt-8 block text-body font-medium text-foreground">
              <span>
                <Trans>Provider</Trans>
              </span>
              <Select
                value={
                  credits
                    ? CREDITS_OPTION
                    : endpointPreset
                      ? `${ENDPOINT_PRESET_OPTION}${endpointPreset.baseUrl}`
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
                  if (value.startsWith(ENDPOINT_PRESET_OPTION))
                    selectProvider(
                      OPENAI_COMPATIBLE_PROVIDER_ID,
                      value.slice(ENDPOINT_PRESET_OPTION.length),
                    );
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
                  <div className="mt-6 block text-body text-foreground">
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
                        <FoundModelPicker
                          models={probeModels}
                          value={modelId}
                          onChange={(next) => {
                            invalidatePreflight();
                            setManualModelId(next === CUSTOM_MODEL_OPTION);
                            setModelId(next === CUSTOM_MODEL_OPTION ? "" : next);
                          }}
                          otherValue={CUSTOM_MODEL_OPTION}
                        />
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
                            <p className="text-body text-muted-foreground">
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
                            <p className="mt-2 text-body text-muted-foreground">
                              <Plural
                                value={Math.ceil(oauth.expiresInSeconds / 60)}
                                one="Waiting for sign-in — the link expires in about # minute."
                                other="Waiting for sign-in — the link expires in about # minutes."
                              />
                            </p>
                          </>
                        ) : (
                          <>
                            <p className="text-body text-muted-foreground">
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
                              <p className="font-mono text-heading2 tracking-[0.2em] text-foreground">
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
                            <p className="mt-2 text-body text-muted-foreground">
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
                {needsRouting && acceptsKey ? (
                  <div className="mt-4 grid gap-4">
                    <label
                      htmlFor={`${fieldId}-account-id`}
                      className="block text-body font-medium text-foreground"
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
                    {needsGateway ? (
                      <label
                        htmlFor={`${fieldId}-gateway-id`}
                        className="block text-body font-medium text-foreground"
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
                      className="mt-4 block text-body text-muted-foreground"
                      keyRequired={Boolean(endpointPreset)}
                    >
                      <Input
                        aria-label={t`API key`}
                        value={apiKey}
                        onChange={(e) => updateApiKey(e.target.value)}
                        required={Boolean(endpointPreset)}
                        placeholder={endpointPreset ? undefined : t`Optional`}
                        type="password"
                        autoComplete="new-password"
                        className="mt-2"
                      />
                    </CompatibleKeyField>
                  ) : (
                    <label
                      htmlFor={`${fieldId}-api-key`}
                      className="mt-4 block text-body font-medium text-foreground"
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
                  <div className="mt-6 block text-body text-foreground">
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
              <p className="mt-3 text-body text-success" role="status">
                {notice}
              </p>
            ) : null}
            {error ? <p className="mt-3 text-body text-destructive">{error}</p> : null}
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
            <p className="text-body text-destructive">{error}</p>
            <Button className="mt-4" onClick={() => void createFirstBot()}>
              <Trans>Try again</Trans>
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
