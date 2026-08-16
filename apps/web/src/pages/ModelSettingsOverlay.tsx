import type { Me } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useEffect, useMemo, useState } from "react";
import {
  type ModelCatalogEntry,
  type ModelCredential,
  providerHint,
  waitForModelOAuth,
} from "../lib/model-auth";
import { rpc } from "../lib/rpc";

type OAuthNotice = {
  verificationUri: string;
  userCode: string;
};

export function ModelSettingsOverlay({ onClose }: { onClose: () => void }) {
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [oauth, setOauth] = useState<OAuthNotice | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"connect" | "default" | null>(null);
  const [oauthPending, setOauthPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    const [nextCatalog, nextCredentials, nextMe] = await Promise.all([
      rpc.models.list(),
      rpc.models.credentials(),
      rpc.me(),
    ]);
    const nextProvider =
      provider && nextCatalog.some((entry) => entry.provider === provider)
        ? provider
        : (nextMe.defaultProvider ?? nextCatalog[0]?.provider ?? "");
    const nextModel =
      nextCatalog.find((entry) => entry.provider === nextProvider && entry.id === modelId)?.id ??
      nextCatalog.find(
        (entry) => entry.provider === nextProvider && entry.id === nextMe.defaultModel,
      )?.id ??
      nextCatalog.find((entry) => entry.provider === nextProvider)?.id ??
      "";
    setCatalog(nextCatalog);
    setCredentials(nextCredentials);
    setMe(nextMe);
    setProvider(nextProvider);
    setModelId(nextModel);
  }

  useEffect(() => {
    void refresh()
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Could not load model settings"),
      )
      .finally(() => setLoading(false));
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
  const modelsForProvider = catalog.filter((entry) => entry.provider === provider);
  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  const credential = credentials.find((entry) => entry.provider === provider);
  const currentEntry = catalog.find(
    (entry) => entry.provider === me?.defaultProvider && entry.id === me?.defaultModel,
  );
  const isActive = me?.defaultProvider === selected?.provider && me?.defaultModel === selected?.id;
  const acceptsKey = selected?.auth !== "oauth";
  const deviceSignIn = selected?.signIn === "device-code";
  const busy = pending !== null || oauthPending;

  function chooseProvider(nextProvider: string) {
    setProvider(nextProvider);
    setModelId(catalog.find((entry) => entry.provider === nextProvider)?.id ?? "");
    setApiKey("");
    setOauth(null);
    setError(null);
    setNotice(null);
  }

  async function setModelDefault() {
    if (!selected || !credential) return;
    setError(null);
    setNotice(null);
    setPending("default");
    try {
      await rpc.models.setDefault({ provider: selected.provider, modelId: selected.id });
      await refresh();
      setNotice(`Now using ${selected.label}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the default model");
    } finally {
      setPending(null);
    }
  }

  async function connectKey() {
    if (!selected || credential || !apiKey.trim()) return;
    setError(null);
    setNotice(null);
    setPending("connect");
    try {
      await rpc.models.connect({
        provider: selected.provider,
        apiKey: apiKey.trim(),
        modelId: selected.id,
        label: selected.providerName ?? selected.provider,
      });
      setApiKey("");
      await refresh();
      setNotice(`Connected and using ${selected.label}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect this provider");
    } finally {
      setPending(null);
    }
  }

  async function startDeviceSignIn() {
    if (!selected) return;
    setError(null);
    setNotice(null);
    setOauthPending(true);
    try {
      const started = await rpc.models.beginOAuth({
        provider: selected.provider,
        modelId: selected.id,
        label: selected.providerName ?? selected.provider,
      });
      setOauth({ verificationUri: started.verificationUri, userCode: started.userCode });
      window.open(started.verificationUri, "_blank", "noopener,noreferrer");
      await waitForModelOAuth(started.loginId);
      setOauth(null);
      await refresh();
      setNotice(`Connected and using ${selected.label}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start sign-in");
      setOauth(null);
    } finally {
      setOauthPending(false);
    }
  }

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-[rgba(4,4,5,.62)] p-4 sm:p-10">
      <div className="flex h-[min(760px,100%)] w-[1080px] max-w-full flex-col overflow-hidden rounded-[26px] border border-[#232326] bg-[#141416] shadow-[0_40px_90px_rgba(0,0,0,.55)]">
        <div className="flex items-start justify-between px-6 pt-6 sm:px-8 sm:pt-7">
          <div>
            <div className="text-2xl font-medium text-[#F1F1F2]">Models</div>
            <p className="mt-1 text-[13.5px] text-[#7A7A80]">
              {loading ? "Loading model catalog…" : "Choose which connected model Rakazo uses."}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close model settings"
            onClick={onClose}
            className="text-[#85858A]"
          >
            ✕
          </button>
        </div>

        <div className="mx-6 mt-5 rounded-[14px] border border-[#26262A] bg-[#101012] px-4 py-3 sm:mx-8">
          <div className="text-[12.5px] uppercase tracking-[0.08em] text-[#6C6C70]">
            Active model
          </div>
          <div className="mt-1 text-[16px] text-[#F1F1F2]">
            {currentEntry?.label ?? me?.defaultModel ?? "Deployment default"}
          </div>
          <div className="mt-1 text-[13px] text-[#85858A]">
            {currentEntry?.providerName ?? me?.defaultProvider ?? "Configured by deployment"}
          </div>
        </div>

        <div className="rk-scroll flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-6 sm:px-8 md:flex-row">
          <div className="md:w-[310px] md:shrink-0">
            <div className="mb-3 text-[13.5px] text-[#85858A]">Providers</div>
            <div className="overflow-hidden rounded-[13px] border border-[#26262A]">
              {groups.map((group) => {
                const connected = credentials.some((entry) => entry.provider === group.id);
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => chooseProvider(group.id)}
                    className={`flex w-full items-center gap-3 border-b border-[#202023] px-3.5 py-3 text-left last:border-0 ${
                      group.id === provider ? "bg-[#1A1A1D]" : "hover:bg-[#161618]"
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] text-[#ECECEE]">
                        {group.name}
                      </span>
                      <span className="mt-0.5 block text-[12px] text-[#6C6C70]">
                        {group.entries.length} model{group.entries.length === 1 ? "" : "s"} ·{" "}
                        {providerHint(group.entries[0]!)}
                      </span>
                    </span>
                    {connected ? (
                      <span className="text-[12px] text-[#4ECB71]">Connected</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="min-w-0 flex-1">
            {error ? <p className="mb-4 text-sm text-[#C94244]">{error}</p> : null}
            {notice ? <p className="mb-4 text-sm text-[#4ECB71]">{notice}</p> : null}
            {selected ? (
              <>
                <label className="block text-[13.5px] text-[#85858A]">
                  Model
                  <select
                    value={selected.id}
                    onChange={(event) => {
                      setModelId(event.target.value);
                      setError(null);
                      setNotice(null);
                    }}
                    className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-[#101012] px-3.5 py-3 text-[#ECECEE] outline-none"
                  >
                    {modelsForProvider.map((entry) => (
                      <option key={`${entry.provider}:${entry.id}`} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="mt-2 text-[13px] leading-[1.5] text-[#85858A]">{selected.billing}</p>

                <div className="mt-5 rounded-[13px] border border-[#26262A] px-4 py-3">
                  <div className="text-[12.5px] uppercase tracking-[0.08em] text-[#6C6C70]">
                    Personal credential
                  </div>
                  <div className="mt-1 text-[15px] text-[#ECECEE]">
                    {credential ? `Connected · ${credential.label}` : "Not connected"}
                  </div>
                  <div className="mt-1 text-[13px] text-[#85858A]">
                    {credential
                      ? "Your key or subscription token is stored securely and is never shown here."
                      : "Connect this provider to use it as your personal model."}
                  </div>
                </div>

                {deviceSignIn ? (
                  <div className="mt-5">
                    {oauth ? (
                      <div className="rounded-[13px] border border-[#26262A] px-4 py-3">
                        <p className="text-sm leading-[1.5] text-[#85858A]">
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
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void startDeviceSignIn()}
                      >
                        {oauthPending ? "Starting…" : (selected.oauthLabel ?? "Sign in")}
                      </Button>
                    )}
                  </div>
                ) : null}

                {acceptsKey && !credential ? (
                  <div className="mt-5">
                    <label className="block text-[13.5px] text-[#85858A]">
                      {deviceSignIn ? "Or connect an API key" : "API key"}
                      <input
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                        placeholder="sk-…"
                        type="password"
                        autoComplete="off"
                        className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-[#101012] px-3.5 py-3 text-[#ECECEE] outline-none"
                      />
                    </label>
                    <Button
                      type="button"
                      variant="pill"
                      size="sm"
                      disabled={busy || apiKey.trim().length < 8}
                      onClick={() => void connectKey()}
                      className="mt-3"
                    >
                      {pending === "connect" ? "Connecting…" : "Connect API key"}
                    </Button>
                  </div>
                ) : null}

                {selected.auth === "oauth" && !deviceSignIn ? (
                  <p className="mt-5 text-sm leading-[1.5] text-[#85858A]">
                    This subscription sign-in is not available in Rakazo yet. Use a deployment
                    credential or choose another provider.
                  </p>
                ) : null}

                {credential ? (
                  <div className="mt-6">
                    <Button
                      type="button"
                      variant={isActive ? "outline" : "pill"}
                      size="sm"
                      disabled={busy || isActive}
                      onClick={() => void setModelDefault()}
                    >
                      {isActive
                        ? "Active model"
                        : pending === "default"
                          ? "Switching…"
                          : "Use this model"}
                    </Button>
                  </div>
                ) : null}
              </>
            ) : loading ? (
              <p className="text-[#85858A]">Loading model catalog…</p>
            ) : (
              <p className="text-[#85858A]">No model catalog is available.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
