import { Trans } from "@lingui/react/macro";
import { Button, Field, FieldError, FieldLabel, Input } from "@rakazo/ui-web";
import { useId, useState } from "react";
import type { MemoryProviderConnectionDraft, MemoryProviderSettingsFormProps } from "./registry";

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]*$/;

export function HonchoSettingsForm({ busy, onConnect }: MemoryProviderSettingsFormProps) {
  const apiKeyId = useId();
  const workspaceId = useId();
  const workspaceErrorId = useId();
  const [apiKey, setApiKey] = useState("");
  const [workspace, setWorkspace] = useState("");
  const workspaceValid = WORKSPACE_ID_PATTERN.test(workspace.trim());

  async function connect() {
    if (!apiKey.trim() || !workspaceValid) return;
    const draft: MemoryProviderConnectionDraft = {
      settings: workspace.trim() ? { workspaceId: workspace.trim() } : {},
      credentials: { apiKey: apiKey.trim() },
    };
    if (await onConnect(draft)) setApiKey("");
  }

  return (
    <>
      <Field>
        <FieldLabel htmlFor={apiKeyId}>
          <Trans>API key</Trans>
        </FieldLabel>
        <Input
          id={apiKeyId}
          value={apiKey}
          disabled={busy}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="hch-…"
          type="password"
          autoComplete="new-password"
        />
      </Field>

      <Field className="mt-4" data-invalid={workspaceValid ? undefined : true}>
        <FieldLabel htmlFor={workspaceId}>
          <Trans>Workspace (optional)</Trans>
        </FieldLabel>
        <Input
          id={workspaceId}
          value={workspace}
          disabled={busy}
          aria-invalid={workspaceValid ? undefined : true}
          aria-describedby={workspaceValid ? undefined : workspaceErrorId}
          onChange={(event) => setWorkspace(event.target.value)}
          placeholder="rakazo-<space>"
          autoComplete="off"
        />
        {!workspaceValid ? (
          <FieldError id={workspaceErrorId}>
            <Trans>Use letters, digits, underscores and hyphens only.</Trans>
          </FieldError>
        ) : null}
      </Field>

      <Button
        type="button"
        variant="secondary"
        className="mt-5 rounded-full"
        size="sm"
        disabled={busy || !apiKey.trim() || !workspaceValid}
        onClick={() => void connect()}
      >
        {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
      </Button>
    </>
  );
}
