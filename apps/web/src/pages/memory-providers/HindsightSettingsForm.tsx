import { Trans } from "@lingui/react/macro";
import { Button, Field, FieldError, FieldLabel, Input, Toggle } from "@rakazo/ui-web";
import { useId, useState } from "react";
import type { MemoryProviderSettingsFormProps } from "./registry";

/** Hindsight serves every bank under one origin, so the bank name is the only scope. */
export const HINDSIGHT_BASE_URL_PLACEHOLDER = "http://127.0.0.1:8892";

export type HindsightFieldError = "required" | "url" | "bank";

export function hindsightConnectionDraft(input: {
  baseUrl: string;
  bank: string;
  readScope: "bank" | "bot";
  allowWrites: boolean;
  token: string;
}):
  | { ok: true; draft: { settings: Record<string, string>; credentials: Record<string, string> } }
  | { ok: false; error: HindsightFieldError } {
  const baseUrl = input.baseUrl.trim();
  if (!baseUrl) return { ok: false, error: "required" };
  if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) return { ok: false, error: "url" };
  const bank = input.bank.trim() || "life";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(bank)) return { ok: false, error: "bank" };
  return {
    ok: true,
    draft: {
      settings: {
        baseUrl,
        bank,
        readScope: input.readScope,
        allowWrites: String(input.allowWrites),
      },
      credentials: { token: input.token.trim() },
    },
  };
}

export function HindsightSettingsForm({ busy, onConnect }: MemoryProviderSettingsFormProps) {
  const baseUrlId = useId();
  const bankId = useId();
  const tokenId = useId();
  const baseUrlErrorId = useId();
  const [baseUrl, setBaseUrl] = useState(HINDSIGHT_BASE_URL_PLACEHOLDER);
  const [bank, setBank] = useState("life");
  const [token, setToken] = useState("");
  const [allowWrites, setAllowWrites] = useState(true);
  const [readScope, setReadScope] = useState<"bank" | "bot">("bank");
  const [error, setError] = useState<HindsightFieldError | null>(null);

  async function connect() {
    const result = hindsightConnectionDraft({ baseUrl, bank, readScope, allowWrites, token });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    if (await onConnect(result.draft)) setToken("");
  }

  return (
    <>
      <Field
        className="mt-4"
        data-invalid={error === "required" || error === "url" ? true : undefined}
      >
        <FieldLabel htmlFor={baseUrlId}>
          <Trans>Hindsight address</Trans>
        </FieldLabel>
        <Input
          id={baseUrlId}
          value={baseUrl}
          required
          disabled={busy}
          aria-invalid={error === "required" || error === "url" ? true : undefined}
          aria-describedby={error === "required" || error === "url" ? baseUrlErrorId : undefined}
          onChange={(event) => {
            setBaseUrl(event.target.value);
            setError(null);
          }}
          placeholder={HINDSIGHT_BASE_URL_PLACEHOLDER}
          autoComplete="off"
        />
        {error === "required" ? (
          <FieldError id={baseUrlErrorId}>
            <Trans>A Hindsight address is required.</Trans>
          </FieldError>
        ) : error === "url" ? (
          <FieldError id={baseUrlErrorId}>
            <Trans>Use an address that starts with http:// or https://.</Trans>
          </FieldError>
        ) : null}
      </Field>

      <Field className="mt-4" data-invalid={error === "bank" ? true : undefined}>
        <FieldLabel htmlFor={bankId}>
          <Trans>Bank</Trans>
        </FieldLabel>
        <Input
          id={bankId}
          value={bank}
          disabled={busy}
          aria-invalid={error === "bank" ? true : undefined}
          onChange={(event) => {
            setBank(event.target.value);
            setError(null);
          }}
          placeholder="life"
          autoComplete="off"
        />
        {error === "bank" ? (
          <FieldError>
            <Trans>A bank name holds up to 64 letters, digits, dots, dashes or underscores.</Trans>
          </FieldError>
        ) : null}
      </Field>

      <Field className="mt-4">
        <FieldLabel>
          <Trans>What this Space reads</Trans>
        </FieldLabel>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
          <Toggle
            pressed={readScope === "bank"}
            disabled={busy}
            onPressedChange={() => setReadScope("bank")}
            className="text-[13px] aria-pressed:bg-background aria-pressed:shadow-sm"
          >
            <Trans>Whole bank</Trans>
          </Toggle>
          <Toggle
            pressed={readScope === "bot"}
            disabled={busy}
            onPressedChange={() => setReadScope("bot")}
            className="text-[13px] aria-pressed:bg-background aria-pressed:shadow-sm"
          >
            <Trans>This bot only</Trans>
          </Toggle>
        </div>
      </Field>

      <Field className="mt-4">
        <FieldLabel htmlFor={tokenId}>
          <Trans>Bearer token (optional)</Trans>
        </FieldLabel>
        <Input
          id={tokenId}
          value={token}
          disabled={busy}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Only when a proxy sits in front"
          type="password"
          autoComplete="new-password"
        />
      </Field>

      <Field className="mt-4">
        <FieldLabel>
          <Trans>Allow writing</Trans>
        </FieldLabel>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
          <Toggle
            pressed={!allowWrites}
            disabled={busy}
            onPressedChange={() => setAllowWrites(false)}
            className="text-[13px] aria-pressed:bg-background aria-pressed:shadow-sm"
          >
            <Trans>Recall only</Trans>
          </Toggle>
          <Toggle
            pressed={allowWrites}
            disabled={busy}
            onPressedChange={() => setAllowWrites(true)}
            className="text-[13px] aria-pressed:bg-background aria-pressed:shadow-sm"
          >
            <Trans>Recall and write</Trans>
          </Toggle>
        </div>
      </Field>

      <Button
        type="button"
        variant="secondary"
        className="mt-5"
        disabled={busy}
        onClick={() => void connect()}
      >
        {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
      </Button>
    </>
  );
}
