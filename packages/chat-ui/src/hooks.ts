import type { MessageBlock } from "@rakazo/contracts";
import type { EmailReplyCommitAction, EmailReplyEdit } from "@rakazo/core";
import {
  applyEmailReplyEdit,
  emailReplyCard,
  emailReplyDraftFromBlock,
  emailReplySaveFields,
} from "@rakazo/core";
import { useEffect, useEffectEvent, useRef, useState } from "react";

/**
 * Calls `callback` once, `ms` after mount. A new `ms` or `restartKey` starts the wait again and
 * `null` cancels it; the latest callback runs, and nothing runs after unmount.
 */
export function useTimeout(callback: () => void, ms: number | null, restartKey?: unknown): void {
  const fire = useEffectEvent(callback);
  useEffect(() => {
    if (ms === null) return;
    const timer = setTimeout(() => fire(), ms);
    return () => clearTimeout(timer);
  }, [ms, restartKey]);
}

type EmailReplyBlock = Extract<MessageBlock, { kind: "email_reply" }>;

function sameFields(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The reply card's draft. Edits stay local until the shared timer saves them, including an edit
 * still waiting when the card goes away. `run` is the screen's save, so a second tap does nothing
 * while one is in flight and the card keeps no pending state of its own.
 */
export function useEmailReplyDraft(options: {
  block: EmailReplyBlock;
  pending: boolean;
  run: (action: EmailReplyCommitAction) => void;
  onEdit: () => void;
}) {
  const [draft, setDraft] = useState(() => emailReplyDraftFromBlock(options.block));
  const draftRef = useRef(draft);
  const saved = useRef(emailReplySaveFields(draft));
  const run = useRef(options.run);
  draftRef.current = draft;
  run.current = options.run;
  const fields = emailReplySaveFields(draft);
  const fieldsKey = JSON.stringify(fields);
  const unsaved = draft.status === "ready" && !sameFields(fields, saved.current);

  useEffect(() => {
    const next = emailReplyDraftFromBlock(options.block);
    const nextFields = emailReplySaveFields(next);
    if (options.block.status === "ready") {
      // Another device may have saved this draft. Adopt it only when this card has nothing unsaved.
      if (!sameFields(emailReplySaveFields(draftRef.current), saved.current)) return;
      if (sameFields(nextFields, saved.current)) return;
    }
    draftRef.current = next;
    saved.current = nextFields;
    setDraft(next);
  }, [options.block]);

  useTimeout(
    () => {
      if (draftRef.current.status !== "ready") return;
      const current = emailReplySaveFields(draftRef.current);
      if (sameFields(current, saved.current)) return;
      saved.current = current;
      run.current({ type: "save", ...current });
    },
    unsaved && !options.pending ? 400 : null,
    fieldsKey,
  );

  useEffect(
    () => () => {
      if (draftRef.current.status !== "ready") return;
      const current = emailReplySaveFields(draftRef.current);
      if (sameFields(current, saved.current)) return;
      saved.current = current;
      run.current({ type: "save", ...current });
    },
    [],
  );

  return {
    draft,
    card: emailReplyCard(draft),
    change(edit: EmailReplyEdit) {
      if (draftRef.current.status !== "ready") return;
      const next = applyEmailReplyEdit(draftRef.current, edit);
      draftRef.current = next;
      setDraft(next);
      options.onEdit();
    },
    send() {
      const current = emailReplySaveFields(draftRef.current);
      run.current({ type: "send", ...current });
    },
    discard() {
      run.current({ type: "discard" });
    },
    replace(block: EmailReplyBlock) {
      const next = emailReplyDraftFromBlock(block);
      draftRef.current = next;
      saved.current = emailReplySaveFields(next);
      setDraft(next);
    },
  };
}

/** `Date.now()`, refreshed every `ms` while it is not `null` and at once when it resumes. */
export function useNow(ms: number | null): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (ms === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
