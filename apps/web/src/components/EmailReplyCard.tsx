import { useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import {
  EmailReplyDraftError,
  EmailReplyDraftStore,
  type EmailReplyEdit,
  emailReplyDraftFromBlock,
} from "@rakazo/core";
import { Button, cn } from "@rakazo/ui-web";
import { useState } from "react";

type EmailReplyBlock = Extract<MessageBlock, { kind: "email_reply" }>;

const fieldClass =
  "w-full border-0 bg-transparent px-0 py-2 text-body text-foreground outline-none disabled:text-muted-foreground";

function Field({
  label,
  value,
  editable,
  onChange,
}: {
  label: string;
  value: string;
  editable: boolean;
  onChange?: (value: string) => void;
}) {
  return (
    <label className="grid grid-cols-[7.5rem_1fr] items-baseline gap-3 border-b border-border px-4">
      <span className="text-body-sm text-muted-foreground">{label}</span>
      <input
        className={fieldClass}
        value={value}
        readOnly={!editable}
        aria-label={label}
        onChange={(event) => onChange?.(event.target.value)}
      />
    </label>
  );
}

/** The review card for a saved email draft. Edits are written back onto that draft. */
export function EmailReplyCard({ block }: { block: EmailReplyBlock }) {
  const { t } = useLingui();
  const [session] = useState(() => {
    const store = new EmailReplyDraftStore();
    const card = store.save(emailReplyDraftFromBlock(block));
    return { store, card };
  });
  const [card, setCard] = useState(session.card);
  const [fields, setFields] = useState({
    inReplyTo: session.card.inReplyTo,
    to: session.card.to,
    cc: session.card.cc,
    subject: session.card.subject,
    body: session.card.body,
  });
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ subject: string; body: string } | null>(null);

  function change(edit: EmailReplyEdit, raw: Partial<typeof fields>) {
    setFields((current) => ({ ...current, ...raw }));
    try {
      setCard(session.store.edit(card.draftId, edit));
      setError(null);
    } catch (err) {
      setError(err instanceof EmailReplyDraftError ? err.message : t`Could not save this draft`);
    }
  }

  function send() {
    try {
      const message = session.store.send(card.draftId);
      setCard(session.store.open(card.draftId));
      setSent({ subject: message.subject, body: message.body });
      setError(null);
    } catch (err) {
      setError(err instanceof EmailReplyDraftError ? err.message : t`Could not send this draft`);
    }
  }

  function discard() {
    try {
      session.store.discard(card.draftId);
      setCard(session.store.open(card.draftId));
      setError(null);
    } catch (err) {
      setError(err instanceof EmailReplyDraftError ? err.message : t`Could not discard this draft`);
    }
  }

  return (
    <section
      data-testid="email-reply-card"
      data-draft-subject={session.store.get(card.draftId).subject}
      data-draft-body={session.store.get(card.draftId).body}
      data-sent-subject={sent?.subject ?? ""}
      className="w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-card text-foreground"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-body font-medium">{t`Reply`}</h2>
        <span className="flex items-center gap-2 text-body-sm text-muted-foreground">
          <span
            className={cn(
              "size-1.5 rounded-full",
              card.status === "ready" ? "bg-foreground" : "bg-muted-foreground",
            )}
            aria-hidden
          />
          {card.statusLabel}
        </span>
      </header>
      <Field label={t`From`} value={card.from} editable={false} />
      <Field
        label={t`In reply to`}
        value={fields.inReplyTo}
        editable={card.editable}
        onChange={(inReplyTo) => change({ inReplyTo }, { inReplyTo })}
      />
      <Field
        label={t`To`}
        value={fields.to}
        editable={card.editable}
        onChange={(to) => change({ to }, { to })}
      />
      <Field
        label={t`Cc`}
        value={fields.cc}
        editable={card.editable}
        onChange={(cc) => change({ cc }, { cc })}
      />
      <Field
        label={t`Subject`}
        value={fields.subject}
        editable={card.editable}
        onChange={(subject) => change({ subject }, { subject })}
      />
      <textarea
        aria-label={t`Message`}
        className="max-h-80 w-full resize-y border-0 bg-transparent px-4 py-3 text-body leading-relaxed text-foreground outline-none disabled:text-muted-foreground"
        rows={card.showToggle && !expanded ? 6 : 12}
        value={fields.body}
        readOnly={!card.editable}
        onChange={(event) => change({ body: event.target.value }, { body: event.target.value })}
      />
      {card.showToggle ? (
        <button
          type="button"
          className="px-4 pb-2 text-body-sm text-muted-foreground"
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? t`Show less` : t`Show more`}
        </button>
      ) : null}
      <footer className="flex items-center gap-2 border-t border-border px-4 py-3">
        <Button type="button" disabled={!card.editable} onClick={send}>
          {t`Send`}
        </Button>
        <Button type="button" variant="outline" disabled={!card.editable} onClick={discard}>
          {t`Discard`}
        </Button>
        <label className="ms-auto text-body-sm text-muted-foreground">
          <span className="sr-only">{t`Approval`}</span>
          <select
            aria-label={t`Approval`}
            className="bg-transparent"
            disabled={!card.editable}
            value={card.approval}
            onChange={(event) =>
              change(
                { approval: event.target.value === "send_once" ? "send_once" : "needs_approval" },
                {},
              )
            }
          >
            <option value="needs_approval">{t`Needs approval`}</option>
            <option value="send_once">{t`Send once`}</option>
          </select>
        </label>
      </footer>
      {error ? <p className="px-4 pb-3 text-body-sm text-destructive">{error}</p> : null}
    </section>
  );
}
