import type { WorkspaceMemoryConfig } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

const DEFAULT_LOCAL_BASE_URL = "http://localhost:6767";

export function SupermemorySettingsOverlay({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<WorkspaceMemoryConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"cloud" | "local">("cloud");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_LOCAL_BASE_URL);
  const [defaultScope, setDefaultScope] = useState<"isolated" | "shared">("isolated");
  const [pending, setPending] = useState<"connect" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const next = await rpc.memory.supermemoryConfig();
    setConfig(next);
    if (next) {
      setMode(next.mode);
      setBaseUrl(next.mode === "local" ? next.baseUrl : DEFAULT_LOCAL_BASE_URL);
      setDefaultScope(next.defaultMemoryScope);
    }
  }

  useEffect(() => {
    void refresh()
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Could not load memory settings"),
      )
      .finally(() => setLoading(false));
  }, []);

  async function connect() {
    if (!apiKey.trim()) return;
    setError(null);
    setPending("connect");
    try {
      await rpc.memory.connectSupermemory({
        mode,
        apiKey: apiKey.trim(),
        baseUrl: mode === "local" ? baseUrl.trim() : undefined,
        defaultMemoryScope: defaultScope,
      });
      setApiKey("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect Supermemory");
    } finally {
      setPending(null);
    }
  }

  async function disconnect() {
    setError(null);
    setPending("disconnect");
    try {
      await rpc.memory.disconnectSupermemory();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect Supermemory");
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-[rgba(4,4,5,.62)] p-4 sm:p-10">
      <div className="flex max-h-[min(760px,100%)] w-[560px] max-w-full flex-col overflow-hidden rounded-[26px] border border-[#232326] bg-[#141416] shadow-[0_40px_90px_rgba(0,0,0,.55)]">
        <div className="flex items-start justify-between px-6 pt-6 sm:px-8 sm:pt-7">
          <div>
            <div className="text-2xl font-medium text-[#F1F1F2]">Memory</div>
            <p className="mt-1 text-[13.5px] text-[#7A7A80]">
              {loading ? "Loading…" : "Connect Supermemory to replace native MEMORY.md memory."}
            </p>
          </div>
          <button type="button" aria-label="Close memory settings" onClick={onClose} className="text-[#85858A]">
            ✕
          </button>
        </div>

        <div className="rk-scroll min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">
          {error ? <p className="mb-4 text-sm text-[#C94244]">{error}</p> : null}

          {config ? (
            <div className="rounded-[13px] border border-[#26262A] px-4 py-3">
              <div className="text-[12.5px] uppercase tracking-[0.08em] text-[#6C6C70]">
                Connected
              </div>
              <div className="mt-1 text-[15px] text-[#ECECEE]">
                {config.mode === "cloud" ? "Supermemory Cloud" : `Local · ${config.baseUrl}`}
              </div>
              <div className="mt-1 text-[13px] text-[#85858A]">
                Default scope for new bots: {config.defaultMemoryScope}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void disconnect()}
                className="mt-3"
              >
                {pending === "disconnect" ? "Disconnecting…" : "Disconnect"}
              </Button>
            </div>
          ) : (
            <>
              <div role="radiogroup" aria-label="Supermemory mode" className="flex gap-2">
                {(["cloud", "local"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={mode === option}
                    onClick={() => setMode(option)}
                    className={`flex-1 rounded-[11px] border px-3.5 py-2.5 text-[14px] ${
                      mode === option
                        ? "border-[#4A4A50] bg-[#1A1A1D] text-[#ECECEE]"
                        : "border-[#26262A] text-[#85858A]"
                    }`}
                  >
                    {option === "cloud" ? "Cloud" : "Local"}
                  </button>
                ))}
              </div>

              {mode === "local" ? (
                <label className="mt-4 block text-[13.5px] text-[#85858A]">
                  Base URL
                  <input
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder={DEFAULT_LOCAL_BASE_URL}
                    className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-[#101012] px-3.5 py-3 text-[#ECECEE] outline-none"
                  />
                </label>
              ) : null}

              <label className="mt-4 block text-[13.5px] text-[#85858A]">
                {mode === "cloud" ? "Organization API key" : "Instance API key"}
                <input
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="sm_…"
                  type="password"
                  autoComplete="new-password"
                  className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-[#101012] px-3.5 py-3 text-[#ECECEE] outline-none"
                />
              </label>

              <div className="mt-4 text-[13.5px] text-[#85858A]">
                Default scope for new bots
                <div role="radiogroup" aria-label="Default memory scope" className="mt-2 flex gap-2">
                  {(["isolated", "shared"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={defaultScope === option}
                      onClick={() => setDefaultScope(option)}
                      className={`flex-1 rounded-[11px] border px-3.5 py-2.5 text-[14px] ${
                        defaultScope === option
                          ? "border-[#4A4A50] bg-[#1A1A1D] text-[#ECECEE]"
                          : "border-[#26262A] text-[#85858A]"
                      }`}
                    >
                      {option === "isolated" ? "Isolated" : "Shared"}
                    </button>
                  ))}
                </div>
              </div>

              <Button
                type="button"
                variant="pill"
                size="sm"
                disabled={busy || apiKey.trim().length < 8 || (mode === "local" && !baseUrl.trim())}
                onClick={() => void connect()}
                className="mt-5"
              >
                {pending === "connect" ? "Connecting…" : "Connect"}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
