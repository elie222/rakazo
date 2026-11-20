import { Trans, useLingui } from "@lingui/react/macro";
import type { WebhookSignature } from "@rakazo/contracts";
import { WEBHOOK_SIGNATURE_SCHEMES } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  FieldLabel,
  Input,
  OptionSelect,
} from "@rakazo/ui-web";
import { useEffect, useEffectEvent, useId, useState } from "react";
import { useSave } from "../../../lib/query/query";
import { errorCode, errorText } from "../../../lib/query/user-error";

type Scheme = WebhookSignature["scheme"];
type Draft = {
  scheme: Scheme;
  header: string;
  timestampHeader: string;
  algorithm: "sha256" | "sha512" | "sha1";
  encoding: "hex" | "base64";
  prefix: string;
};

export function useWebhookSignatureLabel() {
  const { t } = useLingui();
  return (scheme: Scheme) =>
    ({
      "standard-webhooks": t`Standard Webhooks`,
      hmac: t`HMAC of the body`,
      "timestamp-v1": "t=…,v1=…",
      "timestamp-v0": "v0=…",
    })[scheme];
}

function draftFrom(signature: WebhookSignature | null): Draft {
  return {
    scheme: signature?.scheme ?? "standard-webhooks",
    header: signature && "header" in signature ? signature.header : "",
    timestampHeader: signature?.scheme === "timestamp-v0" ? signature.timestampHeader : "",
    algorithm: signature?.scheme === "hmac" ? signature.algorithm : "sha256",
    encoding: signature?.scheme === "hmac" ? signature.encoding : "hex",
    prefix: signature?.scheme === "hmac" ? signature.prefix : "",
  };
}

function signatureFrom(draft: Draft): WebhookSignature | null {
  const header = draft.header.trim();
  const timestampHeader = draft.timestampHeader.trim();
  switch (draft.scheme) {
    case "standard-webhooks":
      return { scheme: draft.scheme };
    case "hmac":
      return header
        ? {
            scheme: draft.scheme,
            header,
            algorithm: draft.algorithm,
            encoding: draft.encoding,
            prefix: draft.prefix.trim(),
          }
        : null;
    case "timestamp-v1":
      return header ? { scheme: draft.scheme, header } : null;
    case "timestamp-v0":
      return header && timestampHeader ? { scheme: draft.scheme, header, timestampHeader } : null;
  }
}

/** Sets the secret a webhook sender generated, and how it signs deliveries with it. */
export function WebhookSignatureDialog({
  botId,
  open,
  onOpenChange,
  signature,
  onSaved,
}: {
  botId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  signature: WebhookSignature | null;
  /** The format now saved for the bot, or null once removed. */
  onSaved: (botId: string, signature: WebhookSignature | null) => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const label = useWebhookSignatureLabel();
  const [draft, setDraft] = useState(() => draftFrom(signature));
  const [secret, setSecret] = useState("");
  const ready = signatureFrom(draft);
  // Null removes the secret; the bot is the one the dialog was opened for.
  const save = useSave({
    save: async (input: { signature: WebhookSignature; secret: string } | null, client) => {
      if (!input) {
        await client.bots.clearWebhookSignature({ botId });
        return null;
      }
      return (await client.bots.setWebhookSignature({ botId, ...input })).webhookSignature;
    },
    onSaved: (saved) => {
      setSecret("");
      onSaved(botId, saved);
      onOpenChange(false);
    },
  });
  const error = save.error
    ? errorCode(save.error) === "FORBIDDEN"
      ? t`Only the bot's creator can set its signing secret.`
      : errorText(save.error)
    : null;
  const change = (next: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...next }));
    save.reset();
  };

  // Each opening starts from what is saved, for whichever bot the card now shows.
  const startOver = useEffectEvent(() => {
    setDraft(draftFrom(signature));
    setSecret("");
    save.reset();
  });
  useEffect(() => {
    if (open) startOver();
  }, [open, signature]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!save.pending) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Signing secret</Trans>
          </DialogTitle>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = secret.trim();
            if (ready && trimmed) save.run({ signature: ready, secret: trimmed });
          }}
        >
          <Field>
            <FieldLabel htmlFor={`${id}-scheme`}>
              <Trans>Format</Trans>
            </FieldLabel>
            <OptionSelect<Scheme>
              id={`${id}-scheme`}
              value={draft.scheme}
              onValueChange={(scheme) => change({ scheme })}
              options={WEBHOOK_SIGNATURE_SCHEMES.map((scheme) => ({
                value: scheme,
                label: label(scheme),
              }))}
            />
          </Field>
          {draft.scheme !== "standard-webhooks" ? (
            <Field>
              <FieldLabel htmlFor={`${id}-header`}>
                <Trans>Signature header</Trans>
              </FieldLabel>
              <Input
                id={`${id}-header`}
                placeholder="x-signature"
                value={draft.header}
                onChange={(event) => change({ header: event.target.value })}
                className="font-mono text-body-sm"
              />
            </Field>
          ) : null}
          {draft.scheme === "timestamp-v0" ? (
            <Field>
              <FieldLabel htmlFor={`${id}-timestamp`}>
                <Trans>Timestamp header</Trans>
              </FieldLabel>
              <Input
                id={`${id}-timestamp`}
                placeholder="x-request-timestamp"
                value={draft.timestampHeader}
                onChange={(event) => change({ timestampHeader: event.target.value })}
                className="font-mono text-body-sm"
              />
            </Field>
          ) : null}
          {draft.scheme === "hmac" ? (
            <div className="grid grid-cols-3 gap-2">
              <OptionSelect<Draft["algorithm"]>
                aria-label={t`Algorithm`}
                value={draft.algorithm}
                onValueChange={(algorithm) => change({ algorithm })}
                options={[
                  { value: "sha256", label: "SHA-256" },
                  { value: "sha512", label: "SHA-512" },
                  { value: "sha1", label: t`SHA-1 (legacy)` },
                ]}
              />
              <OptionSelect<Draft["encoding"]>
                aria-label={t`Encoding`}
                value={draft.encoding}
                onValueChange={(encoding) => change({ encoding })}
                options={[
                  { value: "hex", label: "Hex" },
                  { value: "base64", label: "Base64" },
                ]}
              />
              <Input
                aria-label={t`Prefix`}
                placeholder="sha256="
                value={draft.prefix}
                onChange={(event) => change({ prefix: event.target.value })}
                className="font-mono text-body-sm"
              />
            </div>
          ) : null}
          <Field>
            <FieldLabel htmlFor={`${id}-secret`}>
              <Trans>Secret</Trans>
            </FieldLabel>
            <Input
              id={`${id}-secret`}
              type="password"
              autoComplete="off"
              placeholder={signature ? "••••••••" : undefined}
              value={secret}
              onChange={(event) => {
                setSecret(event.target.value);
                save.reset();
              }}
              className="font-mono text-body-sm"
            />
            <FieldError>{error}</FieldError>
          </Field>
          <DialogFooter>
            {signature ? (
              <Button
                type="button"
                variant="destructive"
                disabled={save.pending}
                onClick={() => save.run(null)}
              >
                <Trans>Remove</Trans>
              </Button>
            ) : null}
            <Button type="submit" disabled={save.pending || !ready || !secret.trim()}>
              <Trans>Save</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
