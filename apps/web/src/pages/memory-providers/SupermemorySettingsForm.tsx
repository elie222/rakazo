import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import type { MemoryProviderConnectionDraft, MemoryProviderSettingsFormProps } from "./registry";

const DEFAULT_LOCAL_BASE_URL = "http://localhost:6767";

export function SupermemorySettingsForm({ busy, onConnect }: MemoryProviderSettingsFormProps) {
  const [mode, setMode] = useState<"cloud" | "local">("cloud");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_LOCAL_BASE_URL);

  async function connect() {
    if (!apiKey.trim()) return;
    const draft: MemoryProviderConnectionDraft = {
      settings: {
        mode,
        ...(mode === "local" ? { baseUrl: baseUrl.trim() } : {}),
      },
      credentials: { apiKey: apiKey.trim() },
    };
    if (await onConnect(draft)) setApiKey("");
  }

  return (
    <>
      <div className="flex gap-2">
        {(["cloud", "local"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={mode === option}
            disabled={busy}
            onClick={() => setMode(option)}
            className={`flex-1 rounded-[11px] border px-3.5 py-2.5 text-[14px] disabled:opacity-40 ${
              mode === option
                ? "border-[#4A4A50] bg-[#1A1A1D] text-[#ECECEE]"
                : "border-[#26262A] text-[#85858A]"
            }`}
          >
            {option === "cloud" ? <Trans>Cloud</Trans> : <Trans>Local</Trans>}
          </button>
        ))}
      </div>

      {mode === "local" ? (
        <label className="mt-4 block text-[13.5px] text-[#85858A]">
          <Trans>Base URL</Trans>
          <input
            value={baseUrl}
            disabled={busy}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={DEFAULT_LOCAL_BASE_URL}
            className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-[#101012] px-3.5 py-3 text-[#ECECEE] outline-none disabled:opacity-40"
          />
        </label>
      ) : null}

      <label className="mt-4 block text-[13.5px] text-[#85858A]">
        {mode === "cloud" ? <Trans>Organization API key</Trans> : <Trans>Instance API key</Trans>}
        <input
          value={apiKey}
          disabled={busy}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="sm_…"
          type="password"
          autoComplete="new-password"
          className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-[#101012] px-3.5 py-3 text-[#ECECEE] outline-none disabled:opacity-40"
        />
      </label>

      <Button
        type="button"
        variant="pill"
        size="sm"
        disabled={busy || apiKey.trim().length < 8 || (mode === "local" && !baseUrl.trim())}
        onClick={() => void connect()}
        className="mt-5"
      >
        {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
      </Button>
    </>
  );
}
