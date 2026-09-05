import { Trans, useLingui } from "@lingui/react/macro";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleConnectReady,
  openAiCompatibleProbeSuccessMessage,
} from "@rakazo/contracts";
import { featuredModelProviders, selectedProviderOutsideSearchResults } from "@rakazo/core";
import { Button, Input, NativeSelect, NativeSelectOption, Textarea } from "@rakazo/ui-web";
import { Check } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { localizedProviderHint } from "../lib/localized-provider-hint";
import type { ModelCatalogEntry } from "../lib/model-auth";
import { rpc } from "../lib/rpc";
import { useModelOAuthSignIn } from "../lib/use-model-oauth-signin";

export function OnboardingPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const fieldId = useId();
  const [step, setStep] = useState<"loading" | "model" | "bot">("loading");
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [query, setQuery] = useState("");
  const [showAllProviders, setShowAllProviders] = useState(false);
  const [provider, setProvider] = useState("openrouter");
  const [modelId, setModelId] = useState("deepseek/deepseek-v4-flash-0731");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [probeModels, setProbeModels] = useState<string[]>([]);
  const [probedBaseUrl, setProbedBaseUrl] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsModel, setNeedsModel] = useState(false);
  const probeRequestIdRef = useRef(0);

  const {
    oauth,
    pasteCode,
    setPasteCode,
    oauthPending,
    cancelOAuthAttempt,
    startSubscriptionSignIn,
    submitOAuthCode,
  } = useModelOAuthSignIn({
    onClearError: () => setError(null),
    onError: setError,
    onFinished: () => {
      setStep("bot");
    },
  });

  useEffect(() => {
    void Promise.all([rpc.me(), rpc.models.list().catch(() => [])])
      .then(([me, models]) => {
        setCatalog(models);
        setNeedsModel(me.needsModel);
        const preferred =
          models.find(
            (entry) => entry.provider === me.defaultProvider && entry.id === me.defaultModel,
          ) ??
          models.find((entry) => entry.provider === me.defaultProvider) ??
          models[0];
        if (preferred) {
          setProvider(preferred.provider);
          setModelId(preferred.provider === OPENAI_COMPATIBLE_PROVIDER_ID ? "" : preferred.id);
        }
        setStep("model");
      })
      .catch(() => setStep("bot"));
    return () => {
      probeRequestIdRef.current += 1;
    };
  }, []);

  const providers = useMemo(() => {
    const seen = new Map<string, ModelCatalogEntry>();
    for (const entry of catalog) {
      if (!seen.has(entry.provider)) seen.set(entry.provider, entry);
    }
    return [...seen.values()];
  }, [catalog]);

  const filteredProviders = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return providers;
    const matching = new Set(
      catalog
        .filter((entry) =>
          `${entry.provider} ${entry.providerName ?? ""} ${entry.label} ${entry.id} ${entry.billing} ${entry.oauthLabel ?? ""}`
            .toLowerCase()
            .includes(q),
        )
        .map((entry) => entry.provider),
    );
    return providers.filter((entry) => matching.has(entry.provider));
  }, [catalog, providers, query]);

  const displayedProviders = useMemo(
    () => (showAllProviders ? filteredProviders : featuredModelProviders(providers, provider)),
    [filteredProviders, provider, providers, showAllProviders],
  );

  const selectedProviderOutsideResults = useMemo(
    () =>
      showAllProviders
        ? selectedProviderOutsideSearchResults(filteredProviders, providers, provider)
        : undefined,
    [filteredProviders, provider, providers, showAllProviders],
  );

  const providerRows = selectedProviderOutsideResults
    ? [selectedProviderOutsideResults, ...displayedProviders]
    : displayedProviders;

  const modelsForProvider = useMemo(
    () => catalog.filter((entry) => entry.provider === provider),
    [catalog, provider],
  );

  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  const isOpenAiCompatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const subscriptionSignIn = selected?.signIn !== undefined;
  const acceptsKey = selected?.auth !== "oauth";
  const signInLabel = selected?.oauthLabel ?? t`Sign in`;
  const openAiCompatibleReady = openAiCompatibleConnectReady({
    baseUrl,
    modelId,
    probedBaseUrl,
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

  async function probeServerModels() {
    const trimmedBaseUrl = baseUrl.trim();
    if (!trimmedBaseUrl) return;
    resetOpenAiCompatibleProbe();
    const requestId = probeRequestIdRef.current;
    setProbing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await rpc.models.probeOpenAiCompatible({
        baseUrl: trimmedBaseUrl,
        apiKey: apiKey.trim() || undefined,
      });
      if (requestId !== probeRequestIdRef.current) return;
      setProbeModels(result.models);
      setProbedBaseUrl(trimmedBaseUrl);
      setModelId((current) => current.trim() || result.models[0] || "");
      setNotice(openAiCompatibleProbeSuccessMessage(result.models.length));
    } catch (err) {
      if (requestId !== probeRequestIdRef.current) return;
      setError(err instanceof Error ? err.message : t`Could not reach this model server`);
    } finally {
      if (requestId === probeRequestIdRef.current) setProbing(false);
    }
  }

  async function saveModel() {
    setError(null);
    try {
      if (isOpenAiCompatible) {
        await rpc.models.connect({
          provider,
          baseUrl: baseUrl.trim(),
          modelId: modelId.trim(),
          apiKey: apiKey.trim() || undefined,
          label: selected?.providerName ?? provider,
        });
      } else if (apiKey) {
        await rpc.models.connect({
          provider,
          apiKey,
          modelId,
          label: selected?.providerName ?? provider,
        });
      }
      setStep("bot");
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save model`);
    }
  }

  function beginSelectedSubscriptionSignIn() {
    void startSubscriptionSignIn({
      provider,
      modelId,
      label: selected?.providerName ?? provider,
    });
  }

  async function createBot() {
    setError(null);
    try {
      const bot = await rpc.bots.create({
        name: name.trim(),
        title,
        description,
        instructions: description,
        notifyOnFinish: true,
      });
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
      setError(err instanceof Error ? err.message : t`Could not create your bot`);
    }
  }

  return (
    <div className="min-h-full bg-background px-6 py-12">
      <div className="mx-auto w-full max-w-[560px]">
        {step === "loading" ? (
          <p className="text-muted-foreground">
            <Trans>Loading…</Trans>
          </p>
        ) : null}
        {step === "model" ? (
          <div>
            <h1 className="text-[32px] font-medium text-foreground">
              <Trans>Connect a model</Trans>
            </h1>
            <div className="mt-8 flex items-center justify-between gap-4">
              <p className="text-sm font-medium text-foreground">
                <Trans>Provider</Trans>
              </p>
              <Button
                variant="link"
                size="xs"
                className="px-0 text-muted-foreground"
                onClick={() => {
                  setShowAllProviders((current) => !current);
                  setQuery("");
                }}
              >
                {showAllProviders ? (
                  <Trans>Show popular providers</Trans>
                ) : (
                  <Trans>Show all providers</Trans>
                )}
              </Button>
            </div>
            {showAllProviders ? (
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={t`Search providers and models`}
                placeholder={t`Search providers and models`}
                className="mt-3"
              />
            ) : null}
            <fieldset
              aria-label={t`Model providers`}
              className={`mt-3 overflow-y-auto rounded-xl border border-border ${
                showAllProviders ? "max-h-64" : ""
              }`}
            >
              {providerRows.map((entry) => {
                const isSelected = entry.provider === provider;
                const isOutsideSearchResults =
                  entry.provider === selectedProviderOutsideResults?.provider;
                return (
                  <button
                    key={entry.provider}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => {
                      if (isSelected) return;
                      cancelOAuthAttempt();
                      setProvider(entry.provider);
                      setModelId(
                        entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID
                          ? ""
                          : (catalog.find((item) => item.provider === entry.provider)?.id ?? ""),
                      );
                      setBaseUrl("");
                      resetOpenAiCompatibleProbe();
                      setError(null);
                      setNotice(null);
                    }}
                    className={`flex min-h-11 w-full items-center gap-3 border-b border-border px-3.5 py-2.5 text-left last:border-0 ${
                      isSelected ? "bg-muted" : "hover:bg-accent"
                    }`}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span
                        className={`truncate text-[15px] text-foreground ${isSelected ? "font-medium" : ""}`}
                      >
                        {entry.provider === "openai-codex"
                          ? "ChatGPT"
                          : (entry.providerName ?? entry.provider)}
                      </span>
                      {isOutsideSearchResults ? (
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          <Trans>Selected</Trans>
                        </span>
                      ) : null}
                    </span>
                    <span className="text-[12px] text-muted-foreground">
                      {localizedProviderHint(entry)}
                    </span>
                    <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden>
                      {isSelected ? (
                        <span className="flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                          <Check className="size-3" strokeWidth={2.5} />
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
              {displayedProviders.length === 0 ? (
                <p className="px-3.5 py-6 text-center text-sm text-muted-foreground">
                  <Trans>No providers found</Trans>
                </p>
              ) : null}
            </fieldset>
            <div className="mt-6 block text-sm text-foreground">
              {isOpenAiCompatible ? (
                <>
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
                  <details className="mt-2 text-[13px] leading-[1.5] text-muted-foreground">
                    <summary className="w-fit cursor-pointer select-none">
                      <Trans>Setup help</Trans>
                    </summary>
                    <p className="mt-1">
                      {t`Paste the OpenAI-compatible address from your server. Rakazo adds /v1 if needed.`}
                    </p>
                  </details>
                  <div className="mt-3">
                    <Button
                      variant="outline"
                      disabled={probing || !baseUrl.trim()}
                      onClick={() => void probeServerModels()}
                    >
                      {probing ? <Trans>Finding…</Trans> : <Trans>Find models</Trans>}
                    </Button>
                  </div>
                  <div className="mt-4 block">
                    <span className="font-medium">
                      <Trans>Model</Trans>
                    </span>
                    {probeModels.length && probeModels.includes(modelId) ? (
                      <NativeSelect
                        value={modelId}
                        onChange={(e) => setModelId(e.target.value)}
                        aria-label={t`Models from server`}
                        className="mt-2 w-full"
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
                        onChange={(e) => setModelId(e.target.value)}
                        aria-label={t`Model id`}
                        placeholder="exact-model-id"
                        className="mt-2"
                      />
                    )}
                    {probeModels.length && !probeModels.includes(modelId) ? (
                      <Button
                        variant="link"
                        size="xs"
                        className="mt-2 px-0 text-muted-foreground"
                        onClick={() => setModelId(probeModels[0] ?? "")}
                      >
                        <Trans>Use a found model</Trans>
                      </Button>
                    ) : null}
                  </div>
                </>
              ) : (
                <>
                  <span className="font-medium">
                    <Trans>Model</Trans>
                  </span>
                  <NativeSelect
                    value={selected?.id ?? modelId}
                    onChange={(e) => {
                      cancelOAuthAttempt();
                      setModelId(e.target.value);
                    }}
                    aria-label={t`Model`}
                    className="mt-2 w-full"
                  >
                    {modelsForProvider.map((entry) => (
                      <NativeSelectOption key={`${entry.provider}:${entry.id}`} value={entry.id}>
                        {entry.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </>
              )}
            </div>
            {subscriptionSignIn ? (
              <div className="mt-4">
                {oauth ? (
                  <div className="rounded-lg border border-border px-3.5 py-3">
                    {oauth.mode === "auth-url" ? (
                      <>
                        <p className="text-sm text-muted-foreground">
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
                        </p>
                        <div className="mt-3 flex items-center gap-2">
                          <Input
                            value={pasteCode}
                            onChange={(e) => setPasteCode(e.target.value)}
                            aria-label={t`Authorization code or callback URL`}
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="http://localhost:53692/callback?code=…"
                          />
                          <Button
                            disabled={!pasteCode.trim()}
                            onClick={() => void submitOAuthCode()}
                          >
                            <Trans>Submit</Trans>
                          </Button>
                        </div>
                        <p className="mt-2 text-sm text-muted-foreground">
                          <Trans>Waiting for sign-in…</Trans>
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm text-muted-foreground">
                          <Trans>
                            Enter this code at{" "}
                            <a
                              href={oauth.verificationUri}
                              target="_blank"
                              rel="noreferrer"
                              className="text-foreground underline"
                            >
                              {oauth.verificationUri.replace(/^https:\/\//, "")}
                            </a>
                          </Trans>
                        </p>
                        <p className="mt-2 font-mono text-[22px] tracking-[0.2em] text-foreground">
                          {oauth.userCode}
                        </p>
                        <p className="mt-2 text-sm text-muted-foreground">
                          <Trans>Waiting for sign-in…</Trans>
                        </p>
                      </>
                    )}
                  </div>
                ) : (
                  <Button disabled={oauthPending} onClick={() => beginSelectedSubscriptionSignIn()}>
                    {oauthPending ? <Trans>Starting…</Trans> : signInLabel}
                  </Button>
                )}
              </div>
            ) : null}
            {acceptsKey ? (
              isOpenAiCompatible ? (
                <details className="mt-4 text-sm text-muted-foreground">
                  <summary className="w-fit cursor-pointer select-none">
                    <Trans>API key</Trans>
                  </summary>
                  <Input
                    aria-label={t`API key`}
                    value={apiKey}
                    onChange={(e) => updateApiKey(e.target.value)}
                    placeholder={t`Optional`}
                    type="password"
                    autoComplete="new-password"
                    className="mt-2"
                  />
                </details>
              ) : (
                <label
                  htmlFor={`${fieldId}-api-key`}
                  className="mt-4 block text-sm font-medium text-foreground"
                >
                  {subscriptionSignIn ? <Trans>Or paste an API key</Trans> : <Trans>API key</Trans>}
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
            ) : subscriptionSignIn ? null : (
              <p className="mt-4 text-sm text-muted-foreground">
                <Trans>
                  This provider cannot paste a key here. Skip if this deployment already has
                  credentials.
                </Trans>
              </p>
            )}
            {notice ? <p className="mt-3 text-sm text-success">{notice}</p> : null}
            {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
            <div className="mt-6 flex gap-3">
              <Button
                disabled={oauthPending || (isOpenAiCompatible && !openAiCompatibleReady)}
                onClick={() => void saveModel()}
              >
                <Trans>Continue</Trans>
              </Button>
              {needsModel ? null : (
                <Button
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => {
                    cancelOAuthAttempt();
                    setStep("bot");
                  }}
                >
                  <Trans>Skip for now</Trans>
                </Button>
              )}
            </div>
          </div>
        ) : null}
        {step === "bot" ? (
          <div>
            <h1 className="text-[32px] font-medium text-foreground">
              <Trans>Create your first bot</Trans>
            </h1>
            <label htmlFor={`${fieldId}-name`} className="mt-8 block text-sm text-muted-foreground">
              <Trans>Name</Trans>
              <Input
                id={`${fieldId}-name`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t`Name this bot`}
                className="mt-2"
              />
            </label>
            <label
              htmlFor={`${fieldId}-title`}
              className="mt-4 block text-sm text-muted-foreground"
            >
              <Trans>Title</Trans>
              <Input
                id={`${fieldId}-title`}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t`Describe what this bot does`}
                className="mt-2"
              />
            </label>
            <label
              htmlFor={`${fieldId}-description`}
              className="mt-4 block text-sm text-muted-foreground"
            >
              <Trans>Description</Trans>
              <Textarea
                id={`${fieldId}-description`}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t`What this bot is for`}
                rows={4}
                className="mt-2"
              />
            </label>
            {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
            <Button className="mt-6" disabled={!name.trim()} onClick={() => void createBot()}>
              <Trans>Continue</Trans>
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
