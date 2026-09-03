import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadMessage } from "@rakazo/contracts";
import { isApprovalAskBlock, isSecretAskBlock, selectedAskActionLabel } from "@rakazo/core";
import { Button, Input } from "@rakazo/ui-web";
import { useState } from "react";

export type AskBlock = Extract<ThreadMessage["blocks"][number], { kind: "ask" }>;

function formatAnsweredState(
  answer: string | undefined,
  approval: boolean,
  secret: boolean,
  outcome?: "created" | "cancelled",
  actions?: AskBlock["actions"],
): string {
  if (secret) return t`Submitted`;
  if (!answer) return t`Answered`;
  if (!approval) return t`Answered: ${selectedAskActionLabel(answer, actions)}`;
  if (outcome === "created") return t`Created`;
  if (outcome === "cancelled") return t`Cancelled`;
  if (answer === "allow") return t`Allowed once`;
  if (answer === "always") return t`Always allowed`;
  if (answer === "deny") return t`Denied`;
  return t`Answered: ${answer}`;
}

function approvalActionLabel(
  id: string,
  fallback: string,
  outcome?: "created" | "cancelled",
): string {
  if (outcome === "created") return t`Create space`;
  if (outcome === "cancelled") return t`Cancel`;
  if (id === "allow") return t`Allow once`;
  if (id === "always") return t`Always allow this tool`;
  if (id === "deny") return t`Deny`;
  return fallback;
}

export function AskCard({
  block,
  canAnswer,
  onAnswer,
}: {
  block: AskBlock;
  canAnswer: boolean;
  onAnswer: (text: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const [editing, setEditing] = useState(false);
  const [answer, setAnswer] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitting = pendingAction !== null;
  const approvalActions = isApprovalAskBlock(block) ? block.actions : undefined;
  const askActions = block.actions;
  const secretInput = isSecretAskBlock(block);

  async function submitAnswer(value: string) {
    if (submitting) return;
    if (secretInput ? value.length === 0 : !value.trim()) return;
    const submitValue = secretInput ? value : value.trim();
    setPendingAction(secretInput ? "submit" : submitValue);
    setError(null);
    try {
      await onAnswer(submitValue);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not submit this answer`);
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="max-w-[74%] rounded-2xl border border-border bg-card px-5 py-4">
      <div className="text-[15.5px] leading-[1.5] text-foreground">
        <ChatMarkdown>{block.text}</ChatMarkdown>
      </div>
      {block.detail ? (
        <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted px-3.5 py-3 font-mono text-[12.5px] leading-[1.7] text-muted-foreground">
          {block.detail}
        </pre>
      ) : null}
      {block.status === "answered" ? (
        <div className="mt-3.5 text-[13.5px] font-medium text-success">
          {formatAnsweredState(
            block.answer,
            Boolean(approvalActions),
            secretInput,
            approvalActions?.find((action) => action.id === block.answer)?.outcome,
            askActions,
          )}
        </div>
      ) : !canAnswer ? (
        <div className="mt-3.5 text-[13.5px] font-medium text-muted-foreground">
          <Trans>No longer active</Trans>
        </div>
      ) : askActions?.length ? (
        <div className="mt-3.5 flex flex-wrap gap-2">
          {askActions.map((action) => (
            <Button
              key={action.id}
              variant={approvalActions && action.id === "allow" ? "default" : "outline"}
              disabled={submitting}
              onClick={() => void submitAnswer(action.id)}
            >
              {pendingAction === action.id ? (
                <Trans>Sending…</Trans>
              ) : approvalActions ? (
                approvalActionLabel(action.id, action.label, action.outcome)
              ) : (
                action.label
              )}
            </Button>
          ))}
        </div>
      ) : secretInput ? (
        <form
          className="mt-3.5 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAnswer(answer);
          }}
        >
          <Input
            aria-label={t`Code`}
            type="password"
            autoComplete="off"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder={t`Code`}
          />
          <Button
            type="submit"
            className="self-start"
            disabled={(secretInput ? answer.length === 0 : !answer.trim()) || submitting}
          >
            {submitting ? <Trans>Sending…</Trans> : <Trans>Submit</Trans>}
          </Button>
        </form>
      ) : editing ? (
        <form
          className="mt-3.5 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAnswer(answer);
          }}
        >
          <Input
            aria-label={t`Answer`}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder={t`Type your answer`}
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={!answer.trim() || submitting}>
              {submitting ? <Trans>Sending…</Trans> : <Trans>Send answer</Trans>}
            </Button>
            <Button
              variant="outline"
              disabled={submitting}
              onClick={() => {
                setAnswer("");
                setEditing(false);
              }}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-3.5 flex gap-2">
          <Button disabled={submitting} onClick={() => void submitAnswer("approved")}>
            {submitting ? <Trans>Sending…</Trans> : <Trans>Send it</Trans>}
          </Button>
          <Button variant="outline" disabled={submitting} onClick={() => setEditing(true)}>
            <Trans>Edit first</Trans>
          </Button>
        </div>
      )}
      {error ? <p className="mt-3 text-[13px] text-destructive">{error}</p> : null}
    </div>
  );
}
