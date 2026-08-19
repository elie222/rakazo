import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  cancelModelOAuthAttempt,
  finishModelOAuthAttempt,
  type ModelCatalogEntry,
  providerHint,
  waitForModelOAuth,
} from "../lib/model-auth";
import { rpc } from "../lib/rpc";

const QUESTIONS = [
  {
    q: "What do you mainly want help with?",
    sub: "Pick whatever’s closest, or type your own.",
    opts: [
      "Inbox & email",
      "Slack & messages",
      "Coding & repos",
      "Research & writing",
      "A bit of everything",
    ],
  },
  {
    q: "How do you want me to write?",
    sub: "I’ll match this unless you say otherwise.",
    opts: [
      "Clear and tight",
      "Warm and conversational",
      "Polished / formal",
      "Match whatever I draft",
    ],
  },
];

export function OnboardingPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<"loading" | "model" | "bot" | "questions">("loading");
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("openrouter");
  const [modelId, setModelId] = useState("deepseek/deepseek-v4-flash-0731");
  const [apiKey, setApiKey] = useState("");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [answers, setAnswers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [oauth, setOauth] = useState<{
    verificationUri: string;
    userCode: string;
  } | null>(null);
  const [oauthPending, setOauthPending] = useState(false);
  const oauthAbortRef = useRef<AbortController | null>(null);
  const oauthLoginIdRef = useRef<string | null>(null);

  function cancelOAuthAttempt(resetState = true) {
    const loginId = oauthLoginIdRef.current;
    oauthLoginIdRef.current = null;
    cancelModelOAuthAttempt(oauthAbortRef, () => {
      if (resetState) {
        setOauth(null);
        setOauthPending(false);
      }
    });
    if (loginId) void rpc.models.cancelOAuth({ loginId }).catch(() => undefined);
  }

  useEffect(() => {
    void Promise.all([rpc.me(), rpc.models.list().catch(() => [])])
      .then(([me, models]) => {
        setCatalog(models);
        const preferred =
          models.find(
            (entry) => entry.provider === me.defaultProvider && entry.id === me.defaultModel,
          ) ??
          models.find((entry) => entry.provider === me.defaultProvider) ??
          models[0];
        if (preferred) {
          setProvider(preferred.provider);
          setModelId(preferred.id);
        }
        setStep("model");
      })
      .catch(() => setStep("bot"));
    return () => cancelOAuthAttempt(false);
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

  const modelsForProvider = useMemo(
    () => catalog.filter((entry) => entry.provider === provider),
    [catalog, provider],
  );

  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  const deviceSignIn = selected?.signIn === "device-code";
  const acceptsKey = selected?.auth !== "oauth";
  const signInLabel = selected?.oauthLabel ?? "Sign in";

  async function saveModel() {
    setError(null);
    try {
      if (apiKey) {
        await rpc.models.connect({
          provider,
          apiKey,
          modelId,
          label: selected?.providerName ?? provider,
        });
      }
      setStep("bot");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save model");
    }
  }

  async function startDeviceSignIn() {
    setError(null);
    setOauthPending(true);
    const controller = new AbortController();
    oauthAbortRef.current = controller;
    try {
      const started = await rpc.models.beginOAuth(
        {
          provider,
          modelId,
          label: selected?.providerName ?? provider,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      oauthLoginIdRef.current = started.loginId;
      setOauth({
        verificationUri: started.verificationUri,
        userCode: started.userCode,
      });
      window.open(started.verificationUri, "_blank", "noopener,noreferrer");
      await waitForModelOAuth(started.loginId, controller.signal);
      if (controller.signal.aborted) return;
      await rpc.models.finishOAuth({ loginId: started.loginId }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      oauthLoginIdRef.current = null;
      setOauth(null);
      setStep("bot");
    } catch (err) {
      if (controller.signal.aborted) return;
      const loginId = oauthLoginIdRef.current;
      oauthLoginIdRef.current = null;
      if (loginId) void rpc.models.cancelOAuth({ loginId }).catch(() => undefined);
      setError(err instanceof Error ? err.message : "Could not start sign-in");
      setOauth(null);
    } finally {
      finishModelOAuthAttempt(oauthAbortRef, controller, () => setOauthPending(false));
    }
  }

  async function createBot() {
    const instructions = answers.length
      ? `User setup:\n${answers.map((a) => `- ${a}`).join("\n")}`
      : description;
    const bot = await rpc.bots.create({
      name: name.trim(),
      title,
      description,
      instructions,
      notifyOnFinish: true,
    });
    navigate(`/app/${bot.id}`);
  }

  const question = QUESTIONS[answers.length];

  return (
    <div className="flex min-h-full items-center justify-center bg-[#0D0D0E] px-6">
      <div className="w-[560px]">
        {step === "loading" ? <p className="text-[#85858A]">Loading…</p> : null}
        {step === "model" ? (
          <div>
            <h1 className="text-[32px] font-medium text-[#F1F1F2]">Connect a model</h1>
            <p className="mt-2 text-[#85858A]">
              Rakazo does not pay for model usage. Paste an API key, sign in with ChatGPT, Copilot,
              or SuperGrok, or skip if this deployment already has a key.
            </p>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search providers and models"
              className="mt-8 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
            />
            <div className="mt-3 max-h-48 overflow-y-auto rounded-[11px] border border-[#26262A]">
              {filteredProviders.map((entry) => (
                <button
                  key={entry.provider}
                  type="button"
                  onClick={() => {
                    cancelOAuthAttempt();
                    setProvider(entry.provider);
                    const first = catalog.find((item) => item.provider === entry.provider);
                    if (first) setModelId(first.id);
                    setError(null);
                  }}
                  className={`flex w-full items-center justify-between border-b border-[#202023] px-3.5 py-2.5 text-left last:border-0 ${
                    entry.provider === provider ? "bg-[#1A1A1D]" : "hover:bg-[#161618]"
                  }`}
                >
                  <span className="text-[15px] text-[#ECECEE]">
                    {entry.providerName ?? entry.provider}
                  </span>
                  <span className="text-[12px] text-[#85858A]">{providerHint(entry)}</span>
                </button>
              ))}
            </div>
            <label className="mt-4 block text-sm text-[#85858A]">
              Model
              <select
                value={selected?.id ?? modelId}
                onChange={(e) => {
                  cancelOAuthAttempt();
                  setModelId(e.target.value);
                }}
                className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
              >
                {modelsForProvider.map((entry) => (
                  <option key={`${entry.provider}:${entry.id}`} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-2 text-[13px] text-[#85858A]">{selected?.billing}</p>
            {deviceSignIn ? (
              <div className="mt-4">
                {oauth ? (
                  <div className="rounded-[11px] border border-[#26262A] px-3.5 py-3">
                    <p className="text-sm text-[#85858A]">
                      Enter this code at{" "}
                      <a
                        href={oauth.verificationUri}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[#ECECEE] underline"
                      >
                        {oauth.verificationUri.replace(/^https:\/\//, "")}
                      </a>
                    </p>
                    <p className="mt-2 font-mono text-[22px] tracking-[0.2em] text-[#F1F1F2]">
                      {oauth.userCode}
                    </p>
                    <p className="mt-2 text-sm text-[#85858A]">Waiting for sign-in…</p>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={oauthPending}
                    onClick={() => void startDeviceSignIn()}
                    className="rounded-[11px] bg-[#F1F1EF] px-5 py-2.5 text-[#17171A] disabled:opacity-40"
                  >
                    {oauthPending ? "Starting…" : signInLabel}
                  </button>
                )}
              </div>
            ) : null}
            {acceptsKey ? (
              <label className="mt-4 block text-sm text-[#85858A]">
                {deviceSignIn ? "Or paste an API key" : "API key"}
                <input
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-…"
                  type="password"
                  className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
                />
              </label>
            ) : deviceSignIn ? null : (
              <p className="mt-4 text-sm text-[#85858A]">
                This provider cannot paste a key here. Skip if this deployment already has
                credentials.
              </p>
            )}
            {error ? <p className="mt-3 text-sm text-[#E65707]">{error}</p> : null}
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                disabled={oauthPending}
                onClick={() => void saveModel()}
                className="rounded-[11px] bg-[#F1F1EF] px-5 py-2.5 text-[#17171A] disabled:opacity-40"
              >
                Continue
              </button>
              <button
                type="button"
                onClick={() => {
                  cancelOAuthAttempt();
                  setStep("bot");
                }}
                className="text-[#85858A]"
              >
                Skip for now
              </button>
            </div>
          </div>
        ) : null}
        {step === "bot" ? (
          <div>
            <h1 className="text-[32px] font-medium text-[#F1F1F2]">Create your first bot</h1>
            <label className="mt-8 block text-sm text-[#85858A]">
              Name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name this bot"
                className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
              />
            </label>
            <label className="mt-4 block text-sm text-[#85858A]">
              Title
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Describe what this bot does"
                className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
              />
            </label>
            <label className="mt-4 block text-sm text-[#85858A]">
              Description
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What this bot is for"
                rows={4}
                className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
              />
            </label>
            <button
              type="button"
              disabled={!name.trim()}
              onClick={() => setStep("questions")}
              className="mt-6 rounded-[11px] bg-[#F1F1EF] px-5 py-2.5 text-[#17171A] disabled:opacity-40"
            >
              Continue
            </button>
          </div>
        ) : null}
        {step === "questions" && question ? (
          <div className="rounded-[20px] bg-[#1A1A1D] p-5">
            <div className="text-[17px] font-medium text-[#F1F1F2]">{question.q}</div>
            <div className="mt-1 text-[15px] text-[#85858A]">{question.sub}</div>
            <div className="mt-3.5 overflow-hidden rounded-[13px] border border-[#232326]">
              {question.opts.map((opt, i) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setAnswers((a) => [...a, opt])}
                  className="flex w-full items-center gap-3.5 border-b border-[#202023] px-4 py-3.5 text-left last:border-0 hover:bg-[#222226]"
                >
                  <span className="grid h-[22px] w-[22px] place-items-center rounded-[6px] bg-[#232327] text-[12.5px] text-[#9A9AA0]">
                    {String.fromCharCode(65 + i)}
                  </span>
                  <span className="text-[15.5px] text-[#ECECEE]">{opt}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {step === "questions" && !question ? (
          <div>
            <h1 className="text-[32px] font-medium text-[#F1F1F2]">You’re set.</h1>
            <p className="mt-2 text-[#85858A]">I’ll pick up work the moment you send it.</p>
            <button
              type="button"
              onClick={() => void createBot()}
              className="mt-6 rounded-[11px] bg-[#F1F1EF] px-5 py-2.5 text-[#17171A]"
            >
              Open Rakazo
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
