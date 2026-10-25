import { Trans } from "@lingui/react/macro";
import { Button, Field, FieldLabel, Input } from "@rakazo/ui-web";
import { useId, useState } from "react";
import type { MemoryProviderSettingsFormProps } from "./registry";

export function RembricSettingsForm({ busy, onConnect }: MemoryProviderSettingsFormProps) {
  const endpointId = useId();
  const tokenId = useId();
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  let validEndpoint = false;
  try {
    const url = new URL(endpoint.trim());
    validEndpoint =
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.href.includes("?") &&
      !url.href.includes("#") &&
      /^\/mcp\/[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/.test(url.pathname);
  } catch {
    // The server validates the project binding and endpoint trust on connect.
  }
  return (
    <>
      <Field className="mt-4">
        <FieldLabel htmlFor={endpointId}>
          <Trans>MCP endpoint</Trans>
        </FieldLabel>
        <Input
          id={endpointId}
          type="url"
          value={endpoint}
          disabled={busy}
          onChange={(event) => setEndpoint(event.target.value)}
          placeholder="https://example.com/mcp/project-slug"
          autoComplete="off"
          maxLength={4096}
        />
      </Field>
      <Field className="mt-4">
        <FieldLabel htmlFor={tokenId}>
          <Trans>Bearer token</Trans>
        </FieldLabel>
        <Input
          id={tokenId}
          type="password"
          value={token}
          disabled={busy}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="new-password"
          maxLength={4096}
        />
      </Field>
      <Button
        type="button"
        variant="secondary"
        className="mt-5"
        disabled={busy || !validEndpoint || !token.trim()}
        onClick={async () => {
          if (
            await onConnect({
              settings: { endpoint: endpoint.trim() },
              credentials: { token: token.trim() },
            })
          )
            setToken("");
        }}
      >
        {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
      </Button>
    </>
  );
}
