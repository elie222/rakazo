import { Trans } from "@lingui/react/macro";
import { Button, Field, FieldLabel, Input, Toggle } from "@rakazo/ui-web";
import { useId, useState } from "react";
import type { MemoryProviderConnectionDraft, MemoryProviderSettingsFormProps } from "./registry";

const DEFAULT_LOCAL_BASE_URL = "http://localhost:6767";

export function SupermemorySettingsForm({ busy, onConnect }: MemoryProviderSettingsFormProps) {
  const baseUrlId = useId();
  const apiKeyId = useId();
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
          <Toggle
            key={option}
            variant="outline"
            pressed={mode === option}
            disabled={busy}
            onPressedChange={() => setMode(option)}
            className="flex-1 font-normal text-muted-foreground aria-pressed:text-foreground"
          >
            {option === "cloud" ? <Trans>Cloud</Trans> : <Trans>Local</Trans>}
          </Toggle>
        ))}
      </div>

      {mode === "local" ? (
        <Field className="mt-4">
          <FieldLabel htmlFor={baseUrlId}>
            <Trans>Base URL</Trans>
          </FieldLabel>
          <Input
            id={baseUrlId}
            value={baseUrl}
            disabled={busy}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={DEFAULT_LOCAL_BASE_URL}
          />
        </Field>
      ) : null}

      <Field className="mt-4">
        <FieldLabel htmlFor={apiKeyId}>
          {mode === "cloud" ? <Trans>Organization API key</Trans> : <Trans>Instance API key</Trans>}
        </FieldLabel>
        <Input
          id={apiKeyId}
          value={apiKey}
          disabled={busy}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="sm_…"
          type="password"
          autoComplete="new-password"
        />
      </Field>

      <Button
        type="button"
        variant="secondary"
        className="mt-5 rounded-full"
        size="sm"
        disabled={busy || apiKey.trim().length < 8 || (mode === "local" && !baseUrl.trim())}
        onClick={() => void connect()}
      >
        {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
      </Button>
    </>
  );
}
