import type { Me } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  cancelModelOAuthAttempt,
  finishModelOAuthAttempt,
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
  const [providerQuery, setProviderQuery] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyLabel, setKeyLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [endpointLabel, setEndpointLabel] = useState("Custom endpoint");
  const [probedModels, setProbedModels] = useState<string[]>([]);
  const [oauth, setOauth] = useState<OAuthNotice | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"connect" | "default" | "probe" | "key" | null>(null);
  const [oauthPending, setOauthPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const detailScrollRef = useRef<HTMLDivElement>(null);
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
    return () => cancelOAuthAttempt(false);
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
  const filteredGroups = useMemo(() => {
    const query = providerQuery.trim().toLowerCase();
    if (!query) return groups;
    return groups.filter((group) =>
      [group.id, group.name, ...group.entries.flatMap((entry) => [entry.id, entry.label])]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [groups, providerQuery]);
  const modelsForProvider = catalog.filter((entry) => entry.provider === provider);
  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  const credential = credentials.find((entry) => entry.provider === provider);
  const currentEntry = catalog.find(
    (entry) => entry.provider === me?.defaultProvider && entry.id === me?.defaultModel,
  );
  const isCustom = Boolean(selected?.custom);
  const isCustomTemplate = selected?.provider === "openai-compatible";
  const isActive = me?.defaultProvider === selected?.provider && me?.defaultModel === selected?.id;
  const acceptsKey = selected?.auth !== "oauth" || isCustom;
  const deviceSignIn = selected?.signIn === "device-code";
  const busy = pending !== null || oauthPending;

  function chooseProvider(nextProvider: string) {
    cancelOAuthAttempt();
    setProvider(nextProvider);
    setModelId(catalog.find((entry) => entry.provider === nextProvider)?.id ?? "");
    detailScrollRef.current?.scrollTo({ top: 0 });
    setApiKey("");
    setKeyLabel("");
    setBaseUrl(catalog.find((entry) => entry.provider === nextProvider)?.baseUrl ?? "");
    setEndpointLabel(
      catalog.find((entry) => entry.provider === nextProvider)?.providerName ?? "Custom endpoint",
    );
    setProbedModels(
      credentials.find((entry) => entry.provider === nextProvider)?.availableModels ?? [],
    );
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
    if (!selected) return;
    if (isCustom) {
      const url = baseUrl.trim() || selected.baseUrl;
      if (!url) {
        setError("Enter a base URL for this endpoint.");
        return;
      }
      setError(null);
      setNotice(null);
      setPending("connect");
      try {
        const connected = await rpc.models.connect({
          provider: selected.provider,
          apiKey: credential ? "" : apiKey.trim(),
          modelId: modelId.trim() || selected.id,
          label: endpointLabel.trim() || selected.providerName || "Custom endpoint",
          baseUrl: url,
          availableModels: probedModels.length
            ? probedModels
            : modelId.trim()
              ? [modelId.trim()]
              : undefined,
        });
        setApiKey("");
        await refresh();
        setProvider(connected.provider);
        setModelId(connected.defaultModel ?? modelId);
        setNotice(`Connected ${connected.label}.`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not connect this endpoint");
      } finally {
        setPending(null);
      }
      return;
    }
    if (!apiKey.trim()) return;
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

  async function probeModels() {
    const url = baseUrl.trim() || selected?.baseUrl;
    if (!url) {
      setError("Enter a base URL to list models.");
      return;
    }
    setError(null);
    setNotice(null);
    setPending("probe");
    try {
      const result = await rpc.models.probe({
        baseUrl: url,
        apiKey: apiKey.trim() || undefined,
      });
      setProbedModels(result.models);
      if (!result.models.includes(modelId) && result.models[0]) setModelId(result.models[0]);
      setNotice(`Found ${result.models.length} model${result.models.length === 1 ? "" : "s"}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not list models");
    } finally {
      setPending(null);
    }
  }

  async function addEndpointKey() {
    if (!selected || !apiKey.trim()) return;
    setError(null);
    setNotice(null);
    setPending("key");
    try {
      await rpc.models.addKey({
        provider: selected.provider,
        apiKey: apiKey.trim(),
        label: keyLabel.trim() || undefined,
      });
      setApiKey("");
      setKeyLabel("");
      await refresh();
      setNotice("Added an API key to this endpoint.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add API key");
    } finally {
      setPending(null);
    }
  }

  async function activateEndpointKey(keyId: string) {
    if (!selected) return;
    setError(null);
    setNotice(null);
    setPending("key");
    try {
      await rpc.models.setActiveKey({ provider: selected.provider, keyId });
      await refresh();
      setNotice("This key is now used for the endpoint.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not switch API key");
    } finally {
      setPending(null);
    }
  }

  async function removeEndpointKey(keyId: string) {
    if (!selected) return;
    setError(null);
    setNotice(null);
    setPending("key");
    try {
      await rpc.models.removeKey({ provider: selected.provider, keyId });
      await refresh();
      setNotice("Removed that API key.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove API key");
    } finally {
      setPending(null);
    }
  }

  async function startDeviceSignIn() {
    if (!selected) return;
    setError(null);
    setNotice(null);
    setOauthPending(true);
    const controller = new AbortController();
    oauthAbortRef.current = controller;
    try {
      const started = await rpc.models.beginOAuth(
        {
          provider: selected.provider,
          modelId: selected.id,
          label: selected.providerName ?? selected.provider,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      oauthLoginIdRef.current = started.loginId;
      setOauth({ verificationUri: started.verificationUri, userCode: started.userCode });
      window.open(started.verificationUri, "_blank", "noopener,noreferrer");
      await waitForModelOAuth(started.loginId, controller.signal);
      if (controller.signal.aborted) return;
      await rpc.models.finishOAuth({ loginId: started.loginId }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      oauthLoginIdRef.current = null;
      setOauth(null);
      await refresh();
      if (controller.signal.aborted) return;
      setNotice(`Connected and using ${selected.label}.`);
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

  function handleClose() {
    cancelOAuthAttempt(false);
    onClose();
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
            onClick={handleClose}
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

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden px-6 py-6 sm:px-8 md:flex-row">
          <div className="flex min-h-0 shrink-0 flex-col md:w-[310px]">
            <div className="mb-3 text-[13.5px] text-[#85858A]">Providers</div>
            <label className="sr-only" htmlFor="model-provider-search">
              Search providers
            </label>
            <input
              id="model-provider-search"
              value={providerQuery}
              onChange={(event) => setProviderQuery(event.target.value)}
              placeholder="Search providers"
              className="w-full rounded-[11px] border border-[#26262A] bg-[#101012] px-3.5 py-2.5 text-[14px] text-[#ECECEE] outline-none placeholder:text-[#6C6C70] focus:border-[#4A4A50]"
            />
            <div className="rk-scroll mt-3 max-h-[240px] overflow-y-auto rounded-[13px] border border-[#26262A] md:min-h-0 md:max-h-none md:flex-1">
              {filteredGroups.length ? (
                filteredGroups.map((group) => {
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
                })
              ) : (
                <p className="px-3.5 py-4 text-[13px] text-[#85858A]">No providers found.</p>
              )}
            </div>
          </div>

          <div ref={detailScrollRef} className="rk-scroll min-h-0 min-w-0 flex-1 overflow-y-auto">
            {error ? <p className="mb-4 text-sm text-[#C94244]">{error}</p> : null}
            {notice ? <p className="mb-4 text-sm text-[#4ECB71]">{notice}</p> : null}
            {selected ? (
              <>
                {isCustom ? (
                  <div className="space-y-4">
                    <label className="block text-[13.5px] text-[#85858A]">
                      Name
                      <input
                        value={endpointLabel}
                        onChange={(event) => setEndpointLabel(event.target.value)}
                        placeholder="Office vLLM"
                        className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-[#101012] px-3.5 py-3 text-[#ECECEE] outline-none"
                      />
                    </label>
                    <label className="block text-[13.5px] text-[#85858A]">
                      Base URL
                      <input
                        value={baseUrl}
                        onChange={(event) => setBaseUrl(event.target.value)}
                        placeholder="https://api.example.com/v1"
                        autoComplete="off"
                        className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-[#101012] px-3.5 py-3 text-[#ECECEE] outline-none"
                      />
                    </label>
                    <p className="text-[13px] leading-[1.5] text-[#85858A]">{selected.billing}</p>
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="block min-w-[220px] flex-1 text-[13.5px] text-[#85858A]">
                        <label htmlFor="custom-endpoint-model">Model id</label>
                        {probedModels.length ||
                        (!isCustomTemplate && modelsForProvider.length > 1) ? (
                          <select
                            id="custom-endpoint-model"
                            value={modelId}
                            onChange={(event) => setModelId(event.target.value)}
                            className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-[#101012] px-3.5 py-3 text-[#ECECEE] outline-none"
                          >
                            {[
                              ...new Set([
                                ...probedModels,
                                ...modelsForProvider.map((entry) => entry.id),
                                modelId,
                              ]),
                            ]
                              .filter(Boolean)
                              .map((id) => (
                                <option key={id} value={id}>
                                  {id}
                                </option>
                              ))}
                          </select>
                        ) : (
                          <input
                            id="custom-endpoint-model"
                            value={isCustomTemplate && modelId === "custom" ? "" : modelId}
                            onChange={(event) => setModelId(event.target.value)}
                            placeholder="llama3.1"
                            className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-[#101012] px-3.5 py-3 text-[#ECECEE] outline-none"
                          />
                        )}
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy || !(baseUrl.trim() || selected.baseUrl)}
                        onClick={() => void probeModels()}
                      >
                        {pending === "probe" ? "Fetching…" : "Fetch models"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="block text-[13.5px] text-[#85858A]">
                      <span>Model</span>
                      <ModelPicker
                        options={modelsForProvider}
                        value={selected.id}
                        onChange={(nextModelId) => {
                          cancelOAuthAttempt();
                          setModelId(nextModelId);
                          setError(null);
                          setNotice(null);
                        }}
                      />
                    </div>
                    <p className="mt-2 text-[13px] leading-[1.5] text-[#85858A]">
                      {selected.billing}
                    </p>
                  </>
                )}

                <div className="mt-5 rounded-[13px] border border-[#26262A] px-4 py-3">
                  <div className="text-[12.5px] uppercase tracking-[0.08em] text-[#6C6C70]">
                    Personal credential
                  </div>
                  <div className="mt-1 text-[15px] text-[#ECECEE]">
                    {credential ? `Connected · ${credential.label}` : "Not connected"}
                  </div>
                  <div className="mt-1 text-[13px] text-[#85858A]">
                    {credential
                      ? isCustom
                        ? credential.baseUrl || "Custom OpenAI-compatible endpoint."
                        : "Your key or subscription token is stored securely and is never shown here."
                      : isCustom
                        ? "Paste any OpenAI-compatible base URL. Add one or more API keys after you connect."
                        : "Connect this provider to use it as your personal model."}
                  </div>
                </div>

                {isCustom && credential ? (
                  <div className="mt-5 rounded-[13px] border border-[#26262A] px-4 py-3">
                    <div className="text-[12.5px] uppercase tracking-[0.08em] text-[#6C6C70]">
                      API keys
                    </div>
                    {credential.keys.length ? (
                      <ul className="mt-3 space-y-2">
                        {credential.keys.map((key) => (
                          <li
                            key={key.id}
                            className="flex items-center gap-2 rounded-[10px] bg-[#101012] px-3 py-2"
                          >
                            <span className="min-w-0 flex-1 truncate text-[14px] text-[#ECECEE]">
                              {key.label}
                            </span>
                            {key.isActive ? (
                              <span className="text-[12px] text-[#4ECB71]">Active</span>
                            ) : (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void activateEndpointKey(key.id)}
                                className="text-[12px] text-[#85858A] hover:text-[#ECECEE]"
                              >
                                Use
                              </button>
                            )}
                            {credential.keys.length > 1 ? (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void removeEndpointKey(key.id)}
                                className="text-[12px] text-[#E65707]"
                              >
                                Remove
                              </button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-[13px] text-[#85858A]">
                        No keys yet. Local servers can run without one.
                      </p>
                    )}
                    <label className="mt-4 block text-[13.5px] text-[#85858A]">
                      Key label
                      <input
                        value={keyLabel}
                        onChange={(event) => setKeyLabel(event.target.value)}
                        placeholder="Pool key 2"
                        className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-[#101012] px-3.5 py-3 text-[#ECECEE] outline-none"
                      />
                    </label>
                    <label className="mt-3 block text-[13.5px] text-[#85858A]">
                      Add API key
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
                      variant="outline"
                      size="sm"
                      disabled={busy || !apiKey.trim()}
                      onClick={() => void addEndpointKey()}
                      className="mt-3"
                    >
                      {pending === "key" ? "Adding…" : "Add API key"}
                    </Button>
                  </div>
                ) : null}

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

                {acceptsKey && !(isCustom && credential) ? (
                  <div className="mt-5">
                    <label className="block text-[13.5px] text-[#85858A]">
                      {credential
                        ? "Replace API key"
                        : deviceSignIn
                          ? "Or connect an API key"
                          : isCustom
                            ? "API key (optional)"
                            : "API key"}
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
                      disabled={
                        busy ||
                        (isCustom
                          ? !(baseUrl.trim() || selected.baseUrl)
                          : apiKey.trim().length < 8)
                      }
                      onClick={() => void connectKey()}
                      className="mt-3"
                    >
                      {pending === "connect"
                        ? "Saving…"
                        : isCustom
                          ? "Connect endpoint"
                          : credential
                            ? "Replace API key"
                            : "Connect API key"}
                    </Button>
                  </div>
                ) : null}

                {isCustom && credential ? (
                  <div className="mt-5">
                    <Button
                      type="button"
                      variant="pill"
                      size="sm"
                      disabled={busy || !(baseUrl.trim() || selected.baseUrl)}
                      onClick={() => void connectKey()}
                    >
                      {pending === "connect" ? "Saving…" : "Save endpoint"}
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

function ModelPicker({
  options,
  value,
  onChange,
}: {
  options: ModelCatalogEntry[];
  value: string;
  onChange: (value: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.id === value),
  );
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(selectedIndex);

  useEffect(() => {
    setHighlightedIndex(selectedIndex);
    setOpen(false);
  }, [selectedIndex, value]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[highlightedIndex]?.focus();
  }, [highlightedIndex, open]);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  function choose(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.id);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveHighlight(index: number) {
    setHighlightedIndex((index + options.length) % options.length);
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
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
      setHighlightedIndex(options.length - 1);
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
      setHighlightedIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setHighlightedIndex(options.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(index);
    } else if (event.key === "Escape") {
      event.preventDefault();
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
        aria-label="Model"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex w-full items-center justify-between rounded-[11px] border border-[#26262A] bg-[#101012] px-3.5 py-3 text-left text-[#ECECEE] outline-none focus-visible:border-[#4A4A50]"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="min-w-0 truncate">{options[selectedIndex]?.label}</span>
        <span className="ml-3 shrink-0 text-[#85858A]" aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Model options"
          className="rk-scroll absolute left-0 right-0 top-full z-20 mt-2 max-h-60 overflow-y-auto rounded-[11px] border border-[#26262A] bg-[#101012] p-1 shadow-[0_20px_45px_rgba(0,0,0,.55)]"
        >
          {options.map((option, index) => (
            <button
              key={`${option.provider}:${option.id}`}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              type="button"
              role="option"
              aria-selected={option.id === value}
              tabIndex={index === highlightedIndex ? 0 : -1}
              className={`w-full rounded-[8px] px-3 py-2 text-left text-[13.5px] text-[#ECECEE] outline-none hover:bg-[#1A1A1D] focus-visible:bg-[#1A1A1D] ${
                option.id === value ? "bg-[#1A1A1D]" : ""
              }`}
              onClick={() => choose(index)}
              onKeyDown={(event) => onOptionKeyDown(event, index)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
