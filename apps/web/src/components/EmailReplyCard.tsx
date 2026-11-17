import { useLingui } from "@lingui/react/macro";
import { useEmailReplyDraft } from "@rakazo/chat-ui/hooks";
import type { MessageBlock } from "@rakazo/contracts";
import type { EmailReplyCommitAction } from "@rakazo/core";
import { Button, OptionSelect, Textarea } from "@rakazo/ui-web";
import { useRef, useState } from "react";
import { useSave } from "../lib/query";
import type { RpcClient } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { BuiCard } from "./ai/primitives";

type EmailReplyBlock = Extract<MessageBlock, { kind: "email_reply" }>;
type ThreadTarget = { botId: string } | { groupId: string };

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
        className="h-9 w-full min-w-0 border-0 bg-transparent px-0 text-body text-foreground outline-none read-only:text-muted-foreground"
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
  const [expanded, setExpanded] = useState(false);
  const session = useRef<ReturnType<typeof useEmailReplyDraft> | null>(null);
  const reply = (input: EmailReplyCommitAction, rpc: RpcClient) =>
    rpc.threads.emailReply({ ...target, messageId, draftId: block.draftId, action: input });
  const autosave = useSave({
    save: reply,
    onSaved: (saved) => {
      if (saved.status === "ready") session.current?.replace(saved);
    },
  });
  const commit = useSave({
    save: reply,
    onSaved: (saved) => {
      if (saved.status !== "ready") session.current?.replace(saved);
    },
  });
  const draft = useEmailReplyDraft({
    block,
    // Autosave may be in flight while the user keeps typing; only a send or discard holds the form.
    pending: autosave.pending || commit.pending,
    run: (action) => (action.type === "save" ? autosave.run(action) : commit.run(action)),
    onEdit: () => {
      autosave.reset();
      commit.reset();
    },
  });
  session.current = draft;
  const { card } = draft;
  const locked = !card.editable || commit.pending;
  const busy = locked || autosave.pending;
  const failure = commit.error ?? autosave.error;
  const error = failure ? errorText(failure) : null;

  return (
    <BuiCard
      data-testid="email-reply-card"
      data-draft-subject={draft.draft.subject}
      data-draft-body={draft.draft.body}
      data-draft-to={draft.draft.toText}
      className="w-full max-w-xl overflow-hidden border border-border text-foreground"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-body font-medium">{t`Mail`}</h2>
        <span className="text-body-sm text-muted-foreground">{card.statusLabel}</span>
      </header>
      <Field label={t`From`} value={card.from} editable={false} />
      {card.showInReplyTo ? (
        <Field
          label={t`In reply to`}
          value={draft.draft.inReplyTo}
          editable={!locked}
          onChange={(inReplyTo) => draft.change({ inReplyTo })}
        />
      ) : null}
      <Field
        label={t`To`}
        value={draft.draft.toText}
        editable={!locked}
        onChange={(to) => draft.change({ to })}
      />
      <Field
        label={t`Cc`}
        value={draft.draft.ccText}
        editable={!locked}
        onChange={(cc) => draft.change({ cc })}
      />
      <Field
        label={t`Subject`}
        value={draft.draft.subject}
        editable={!locked}
        onChange={(subject) => draft.change({ subject })}
      />
      <Textarea
        aria-label={t`Message`}
        className="max-h-80 min-h-32 w-full resize-y rounded-none border-0 bg-transparent px-4 py-3 shadow-none focus-visible:ring-0"
        rows={card.showToggle && !expanded ? 6 : 12}
        value={draft.draft.body}
        readOnly={locked}
        onChange={(event) => draft.change({ body: event.target.value })}
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
        <Button type="button" disabled={busy} onClick={() => draft.send()}>
          {t`Send`}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => draft.discard()}>
          {t`Discard`}
        </Button>
        <div className="ms-auto w-40">
          <OptionSelect
            aria-label={t`Approval`}
            size="sm"
            disabled={locked}
            value={draft.draft.approval}
            options={[
              { value: "needs_approval", label: t`Needs approval` },
              { value: "send_once", label: t`Send once` },
            ]}
            onValueChange={(approval) => draft.change({ approval })}
          />
        </div>
      </footer>
      {error ? <p className="px-4 pb-3 text-body-sm text-destructive">{error}</p> : null}
    </BuiCard>
  );
}
