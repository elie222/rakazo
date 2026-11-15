import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Field, FieldLabel, Input } from "@rakazo/ui-web";
import { useId, useState } from "react";
import type { ConnectionMode } from "./ConnectionModeFields";
import { ConnectionModeFields } from "./ConnectionModeFields";
import { MemoryProviderAdvanced } from "./MemoryProviderAdvanced";
import type { MemoryProviderConnectionDraft, MemoryProviderSettingsFormProps } from "./registry";

export function SupermemorySettingsForm({
  busy,
  current,
  onConnect,
  advancedSettings,
}: MemoryProviderSettingsFormProps) {
  const { t } = useLingui();
  const editing = current !== undefined;
  const apiKeyId = useId();
  const [mode, setMode] = useState<ConnectionMode>(current?.mode === "local" ? "local" : "cloud");
  const [apiKey, setApiKey] = useState("");
  // A cloud connection stores the cloud URL, which is not the self-hosted address to edit.
  const [baseUrl, setBaseUrl] = useState(current?.mode === "local" ? (current.baseUrl ?? "") : "");
  const key = apiKey.trim();
  // Editing keeps the stored key only while the host is unchanged.
  const keepsKey =
    current !== undefined &&
    mode === (current.mode === "local" ? "local" : "cloud") &&
    (mode === "cloud" ||
      baseUrl.trim().replace(/\/+$/, "") === (current.baseUrl ?? "").trim().replace(/\/+$/, ""));
  const ready =
    (key.length === 0 ? keepsKey : key.length >= 8) &&
    (mode === "cloud" || Boolean(baseUrl.trim()));

  async function connect() {
    if (!ready) return;
    const draft: MemoryProviderConnectionDraft = {
      settings: {
        mode,
        ...(mode === "local" ? { baseUrl: baseUrl.trim() } : {}),
      },
      credentials: key ? { apiKey: key } : {},
    };
    if (await onConnect(draft)) setApiKey("");
  }

  return (
    <>
      <Field className="mt-4">
        <FieldLabel htmlFor={apiKeyId}>
          {mode === "cloud" ? <Trans>Organization API key</Trans> : <Trans>Instance API key</Trans>}
        </FieldLabel>
        <Input
          id={apiKeyId}
          value={apiKey}
          disabled={busy}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={keepsKey ? t`Saved` : "sm_…"}
          type="password"
          autoComplete="new-password"
        />
      </Field>

      <MemoryProviderAdvanced>
        {advancedSettings}
        <ConnectionModeFields
          busy={busy}
          mode={mode}
          onModeChange={setMode}
          baseUrl={baseUrl}
          onBaseUrlChange={setBaseUrl}
        />
      </MemoryProviderAdvanced>

      <Button
        type="button"
        variant="secondary"
        className="mt-5"
        disabled={busy || !ready}
        onClick={() => void connect()}
      >
        {editing ? (
          busy ? (
            <Trans>Saving…</Trans>
          ) : (
            <Trans>Save</Trans>
          )
        ) : busy ? (
          <Trans>Connecting…</Trans>
        ) : (
          <Trans>Connect</Trans>
        )}
      </Button>
    </>
  );
}
