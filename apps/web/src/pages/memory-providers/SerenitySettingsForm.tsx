import { Trans } from "@lingui/react/macro";
import { Button, Field, FieldError, FieldLabel, Input, Toggle } from "@rakazo/ui-web";
import { useId, useState } from "react";
import type { MemoryProviderSettingsFormProps } from "./registry";
import type { SerenityEndpointFieldError } from "./serenity-settings";
import { SERENITY_ENDPOINT_PLACEHOLDER, serenityConnectionDraft } from "./serenity-settings";

export function SerenitySettingsForm({ busy, onConnect }: MemoryProviderSettingsFormProps) {
  const endpointId = useId();
  const endpointErrorId = useId();
  const tokenId = useId();
  const brainLabelId = useId();
  const [endpoint, setEndpoint] = useState("");
  const [endpointError, setEndpointError] = useState<SerenityEndpointFieldError | null>(null);
  const [token, setToken] = useState("");
  const [brainLabel, setBrainLabel] = useState("");
  const [allowWrites, setAllowWrites] = useState(false);

  async function connect() {
    const result = serenityConnectionDraft({ endpoint, token, brainLabel, allowWrites });
    if (!result.ok) {
      setEndpointError(result.error);
      return;
    }
    if (token.trim().length < 8) return;
    setEndpointError(null);
    if (await onConnect(result.draft)) setToken("");
  }

  return (
    <>
      <Field className="mt-1" data-invalid={endpointError ? true : undefined}>
        <FieldLabel htmlFor={endpointId}>
          <Trans>MCP endpoint</Trans>
        </FieldLabel>
        <Input
          id={endpointId}
          value={endpoint}
          required
          disabled={busy}
          aria-invalid={endpointError ? true : undefined}
          aria-describedby={endpointError ? endpointErrorId : undefined}
          onChange={(event) => {
            setEndpoint(event.target.value);
            setEndpointError(null);
          }}
          placeholder={SERENITY_ENDPOINT_PLACEHOLDER}
          autoComplete="off"
        />
        {endpointError === "required" ? (
          <FieldError id={endpointErrorId}>
            <Trans>Serenity endpoint is required.</Trans>
          </FieldError>
        ) : null}
      </Field>

      <Field className="mt-4">
        <FieldLabel htmlFor={tokenId}>
          <Trans>Bearer token</Trans>
        </FieldLabel>
        <Input
          id={tokenId}
          value={token}
          disabled={busy}
          onChange={(event) => setToken(event.target.value)}
          placeholder="sk_live_…"
          type="password"
          autoComplete="new-password"
        />
      </Field>

      <Field className="mt-4">
        <FieldLabel htmlFor={brainLabelId}>
          <Trans>Brain label</Trans>
        </FieldLabel>
        <Input
          id={brainLabelId}
          value={brainLabel}
          disabled={busy}
          onChange={(event) => setBrainLabel(event.target.value)}
          placeholder="personal"
          autoComplete="off"
        />
      </Field>

      <div className="mt-4 text-[13.5px] text-muted-foreground">
        <Trans>Allow writing</Trans>
        <div className="mt-2 flex gap-2">
          <Toggle
            variant="outline"
            pressed={!allowWrites}
            disabled={busy}
            onPressedChange={() => setAllowWrites(false)}
            className="flex-1 font-normal text-muted-foreground aria-pressed:text-foreground"
          >
            <Trans>Recall only</Trans>
          </Toggle>
          <Toggle
            variant="outline"
            pressed={allowWrites}
            disabled={busy}
            onPressedChange={() => setAllowWrites(true)}
            className="flex-1 font-normal text-muted-foreground aria-pressed:text-foreground"
          >
            <Trans>Recall and write</Trans>
          </Toggle>
        </div>
      </div>

      <Button
        type="button"
        variant="secondary"
        className="mt-5 rounded-full"
        size="sm"
        disabled={busy || token.trim().length < 8}
        onClick={() => void connect()}
      >
        {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
      </Button>
    </>
  );
}
