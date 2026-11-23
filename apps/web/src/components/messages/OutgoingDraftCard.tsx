import { Trans, useLingui } from "@lingui/react/macro";
import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import {
  OutgoingDraftValues,
  outgoingDraftAnswer,
  outgoingDraftPresentation,
} from "@rakazo/contracts";
import { Button, Input, Textarea } from "@rakazo/ui-web";
import { Mail, MessageSquare } from "lucide-react";
import { useId, useState } from "react";
import type { ArtifactTarget } from "../../lib/pages/artifact-open";
import { useSave } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { BuiCard } from "../ai/primitives";

export function OutgoingDraftCard({
  block,
  message,
  target,
  canAnswer,
}: {
  block: Extract<MessageBlock, { kind: "ask" }>;
  message: ThreadMessage;
  target: ArtifactTarget;
  canAnswer: boolean;
}) {
  const draft = block.outgoingDraft!;
  const { t } = useLingui();
  const id = useId();
  const [values, setValues] = useState(draft.values);
  const answer = useSave({
    save: (input: string, rpc) =>
      rpc.threads.answer({
        ...target,
        runId: message.runId!,
        messageId: message.id,
        answer: input,
      }),
  });
  const { status, shown, isEmail } = outgoingDraftPresentation(
    block,
    draft.values,
    values,
    canAnswer && Boolean(message.runId),
    !answer.pending && !answer.error ? answer.input : undefined,
  );
  const open = status === "pending";
  const toLabel = t`To`;
  const Icon = isEmail ? Mail : MessageSquare;
  const inlineField = "rounded-sm border-transparent px-0 py-0 shadow-none dark:bg-transparent";

  return (
    <BuiCard
      data-testid="outgoing-draft-card"
      className="w-full min-w-0 max-w-xl overflow-hidden border border-border"
    >
      <div className="px-5 pt-5 sm:px-6">
        <div className="flex items-center gap-2 text-body-sm text-muted-foreground">
          <Icon aria-hidden="true" className="size-4 shrink-0" />
          {t`${draft.source} draft`}
        </div>
        {open && block.detail ? (
          <p className="mt-3 whitespace-pre-wrap break-words border-s-2 border-warning ps-3 text-body-sm">
            {block.detail}
          </p>
        ) : null}
        <fieldset disabled={answer.pending} className="mt-4 min-w-0">
          {shown.kind === "email" ? (
            open && values.kind === "email" ? (
              <Input
                aria-label={t`Subject`}
                placeholder={t`Subject`}
                className={`${inlineField} mb-1 text-body-lg font-semibold md:text-body-lg`}
                value={values.subject}
                onChange={(event) => setValues({ ...values, subject: event.target.value })}
              />
            ) : shown.subject ? (
              <p className="mb-1 break-words py-2 text-body-lg font-semibold">{shown.subject}</p>
            ) : null
          ) : null}
          <div className="flex min-w-0 items-baseline gap-3 border-b border-border pb-2">
            {open ? (
              <label htmlFor={`${id}-to`} className="shrink-0 text-body-sm text-muted-foreground">
                {toLabel}
              </label>
            ) : (
              <span className="shrink-0 text-body-sm text-muted-foreground">{toLabel}</span>
            )}
            {open ? (
              <Textarea
                id={`${id}-to`}
                rows={1}
                inputMode={isEmail ? "email" : "text"}
                spellCheck={false}
                autoCapitalize="none"
                className={`${inlineField} min-h-0 resize-none break-all`}
                value={values.to}
                onChange={(event) => setValues({ ...values, to: event.target.value })}
              />
            ) : (
              <p className="min-w-0 break-all text-body">{shown.to}</p>
            )}
          </div>
          <div className="py-4">
            {open ? (
              <Textarea
                aria-label={t`Message`}
                placeholder={t`Message`}
                rows={3}
                className={`${inlineField} min-h-20 resize-none leading-relaxed`}
                value={values.body}
                onChange={(event) => setValues({ ...values, body: event.target.value })}
              />
            ) : (
              <p className="whitespace-pre-wrap break-words leading-relaxed">{shown.body}</p>
            )}
          </div>
        </fieldset>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3 sm:px-6">
        {open ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              disabled={answer.pending}
              onClick={() => answer.run("deny")}
            >
              <Trans>Discard</Trans>
            </Button>
            <Button
              type="button"
              size="sm"
              className="min-w-16"
              disabled={answer.pending || !OutgoingDraftValues.safeParse(values).success}
              onClick={() => answer.run(outgoingDraftAnswer(values))}
            >
              <Trans>Send</Trans>
            </Button>
          </>
        ) : (
          <div className="text-body-sm text-muted-foreground">
            {status === "expired"
              ? t`Expired`
              : status === "discarded"
                ? t`Discarded`
                : status === "approved"
                  ? t`Approved`
                  : t`No longer active`}
          </div>
        )}
      </div>
      {answer.error ? (
        <p role="alert" className="px-5 pb-3 text-body-sm text-destructive sm:px-6">
          {errorText(answer.error, t`Couldn’t submit the draft`)}
        </p>
      ) : null}
    </BuiCard>
  );
}
