import { Trans } from "@lingui/react/macro";
import { Button, Field, FieldLabel, Input } from "@rakazo/ui-web";
import { useId, useState } from "react";
import { MEMMY_ENDPOINT_PLACEHOLDER, memmyConnectionDraft } from "./memmy-settings";
import type { MemoryProviderSettingsFormProps } from "./registry";

export function MemmySettingsForm({ busy, onConnect }: MemoryProviderSettingsFormProps) {
  const endpointId = useId();
  const tokenId = useId();
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  // Both fields are required, so Connect stays disabled instead of adding error copy;
  // URL validity is the backend's classification, shown by the overlay after connect.
  const incomplete = !endpoint.trim() || token.trim().length < 8;

  async function connect() {
    const result = memmyConnectionDraft({ endpoint, token });
    if (!result.ok) return;
    if (await onConnect(result.draft)) setToken("");
  }

  return (
    <>
      <Field className="mt-4">
        <FieldLabel htmlFor={endpointId}>
          <Trans>Server URL</Trans>
        </FieldLabel>
        <Input
          id={endpointId}
          value={endpoint}
          required
          disabled={busy}
          onChange={(event) => setEndpoint(event.target.value)}
          placeholder={MEMMY_ENDPOINT_PLACEHOLDER}
          autoComplete="off"
        />
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
          type="password"
          autoComplete="new-password"
        />
      </Field>

      <Button
        type="button"
        variant="secondary"
        className="mt-5"
        disabled={busy || incomplete}
        onClick={() => void connect()}
      >
        {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
      </Button>
    </>
  );
}
