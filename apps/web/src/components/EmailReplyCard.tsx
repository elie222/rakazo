import { useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import type { EmailReplyEdit } from "@rakazo/core";
import {
  applyEmailReplyEdit,
  emailReplyCard,
  emailReplyDraftFromBlock,
  emailReplySaveFields,
} from "@rakazo/core";
import { Button, OptionSelect } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

type EmailReplyBlock = Extract<MessageBlock, { kind: "email_reply" }>;
type ThreadTarget = { botId: string } | { groupId: string };

const fieldClass =
  "w-full border-0 bg-transparent px-0 py-2 text-body text-foreground outline-none read-only:text-muted-foreground";

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
export function EmailReplyCard({
  block,
  messageId,
  target,
}: {
  block: EmailReplyBlock;
  messageId: string;
  target: ThreadTarget;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(() => emailReplyDraftFromBlock(block));
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const card = emailReplyCard(draft);

  useEffect(() => {
    if (block.status !== "ready") setDraft(emailReplyDraftFromBlock(block));
  }, [block]);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  function persist(next: typeof draft) {
    const fields = emailReplySaveFields(next);
    return rpc.threads.emailReply({
      ...target,
      messageId,
      draftId: next.id,
      action: { type: "save", ...fields },
    });
  }

  function change(edit: EmailReplyEdit) {
    let next: typeof draft;
    try {
      next = applyEmailReplyEdit(draft, edit);
    } catch (err) {
      setError(errorText(err));
      return;
    }
    setDraft(next);
    setError(null);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void persist(next).catch((err: unknown) => setError(errorText(err)));
    }, 400);
  }

  async function send() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    try {
      const saved = await rpc.threads.emailReply({
        ...target,
        messageId,
        draftId: draft.id,
        action: { type: "send", ...emailReplySaveFields(draft) },
      });
      setDraft(emailReplyDraftFromBlock(saved));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function discard() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    try {
      const saved = await rpc.threads.emailReply({
        ...target,
        messageId,
        draftId: draft.id,
        action: { type: "discard" },
      });
      setDraft(emailReplyDraftFromBlock(saved));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <section
      data-testid="email-reply-card"
      data-draft-subject={draft.subject}
      data-draft-body={draft.body}
      data-draft-to={draft.toText}
      className="w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-card text-foreground"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-body font-medium">{t`Mail`}</h2>
        <span className="text-body-sm text-muted-foreground">{card.statusLabel}</span>
      </header>
      <Field label={t`From`} value={card.from} editable={false} />
      <Field
        label={t`In reply to`}
        value={draft.inReplyTo}
        editable={card.editable}
        onChange={(inReplyTo) => change({ inReplyTo })}
      />
      <Field
        label={t`To`}
        value={draft.toText}
        editable={card.editable}
        onChange={(to) => change({ to })}
      />
      <Field
        label={t`Cc`}
        value={draft.ccText}
        editable={card.editable}
        onChange={(cc) => change({ cc })}
      />
      <Field
        label={t`Subject`}
        value={draft.subject}
        editable={card.editable}
        onChange={(subject) => change({ subject })}
      />
      <textarea
        aria-label={t`Message`}
        className="max-h-80 w-full resize-y border-0 bg-transparent px-4 py-3 text-body leading-relaxed text-foreground outline-none read-only:text-muted-foreground"
        rows={card.showToggle && !expanded ? 6 : 12}
        value={draft.body}
        readOnly={!card.editable}
        onChange={(event) => change({ body: event.target.value })}
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
        <Button type="button" disabled={!card.editable} onClick={() => void send()}>
          {t`Send`}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!card.editable}
          onClick={() => void discard()}
        >
          {t`Discard`}
        </Button>
        <div className="ms-auto w-40">
          <OptionSelect
            aria-label={t`Approval`}
            size="sm"
            disabled={!card.editable}
            value={draft.approval}
            options={[
              { value: "needs_approval", label: t`Needs approval` },
              { value: "send_once", label: t`Send once` },
            ]}
            onValueChange={(approval) => change({ approval })}
          />
        </div>
      </footer>
      {error ? <p className="px-4 pb-3 text-body-sm text-destructive">{error}</p> : null}
    </section>
  );
}
