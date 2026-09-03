import { Trans, useLingui } from "@lingui/react/macro";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleConnectReady,
  openAiCompatibleProbeSuccessMessage,
} from "@rakazo/contracts";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@rakazo/ui-web";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ModelCatalogEntry } from "../lib/model-auth";
import { rpc } from "../lib/rpc";
import { useModelOAuthSignIn } from "../lib/use-model-oauth-signin";

function providerLabel(entry: ModelCatalogEntry): string {
  if (entry.provider === "openai-codex") return "ChatGPT";
  return entry.providerName ?? entry.provider;
}

export function OnboardingPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const fieldId = useId();
  const [step, setStep] = useState<"loading" | "model" | "bot">("loading");
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [provider, setProvider] = useState("openrouter");
  const [modelId, setModelId] = useState("deepseek/deepseek-v4-flash-0731");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [probeModels, setProbeModels] = useState<string[]>([]);
  const [probedBaseUrl, setProbedBaseUrl] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [name, setName] = useState(() => t`Assistant`);
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

  const providerItems = useMemo(
    () =>
      providers.map((entry) => ({
        value: entry.provider,
        label: providerLabel(entry),
      })),
    [providers],
  );

  const modelsForProvider = useMemo(
    () => catalog.filter((entry) => entry.provider === provider),
    [catalog, provider],
  );

  const modelItems = useMemo(
    () =>
      modelsForProvider.map((entry) => ({
        value: entry.id,
        label: entry.label,
      })),
    [modelsForProvider],
  );

  const otherProbeModelValue = "__other__";
  const probeModelItems = useMemo(
    () => [
      ...probeModels.map((id) => ({ value: id, label: id })),
      { value: otherProbeModelValue, label: t`Other model…` },
    ],
    [probeModels, t],
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

  function selectProvider(nextProvider: string | null) {
    if (!nextProvider || nextProvider === provider) return;
    cancelOAuthAttempt();
    setProvider(nextProvider);
    setApiKey("");
    setModelId(
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? ""
        : (catalog.find((item) => item.provider === nextProvider)?.id ?? ""),
    );
    setBaseUrl("");
    resetOpenAiCompatibleProbe();
    setError(null);
    setNotice(null);
  }

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
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: true,
      });
      // Onboarding continues conversationally in the thread: greeting, focus
      // choice, and Composio authorize cards.
      await rpc.onboarding.start({ botId: bot.id }).catch(() => undefined);
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
            <p className="mt-2 text-muted-foreground">
              <Trans>Choose a model to get started.</Trans>
            </p>
            <div className="mt-8 block text-sm text-foreground">
              <span className="font-medium">
                <Trans>Provider</Trans>
              </span>
              <Select
                items={providerItems}
                value={provider}
                onValueChange={(value) => selectProvider(value)}
              >
                <SelectTrigger aria-label={t`Provider`} className="mt-2 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  {providerItems.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="mt-4 block text-sm text-foreground">
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
                      <Select
                        items={probeModelItems}
                        value={modelId}
                        onValueChange={(value) => {
                          if (!value || value === otherProbeModelValue) {
                            setModelId("");
                            return;
                          }
                          setModelId(value);
                        }}
                      >
                        <SelectTrigger aria-label={t`Models from server`} className="mt-2 w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent alignItemWithTrigger={false}>
                          {probeModelItems.map((entry) => (
                            <SelectItem key={entry.value} value={entry.value}>
                              {entry.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
                  <Select
                    items={modelItems}
                    value={selected?.id ?? modelId}
                    onValueChange={(value) => {
                      if (!value) return;
                      cancelOAuthAttempt();
                      setModelId(value);
                    }}
                  >
                    <SelectTrigger aria-label={t`Model`} className="mt-2 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      {modelItems.map((entry) => (
                        <SelectItem key={entry.value} value={entry.value}>
                          {entry.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
