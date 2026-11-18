import { Trans, useLingui } from "@lingui/react/macro";
import { transcriptTime } from "@rakazo/i18n/meeting";
import { Button, Input } from "@rakazo/ui-web";
import type { QueryKey } from "@tanstack/react-query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import { errorDetails } from "../../../lib/query/user-error";
import { useEventListener } from "../../../lib/use-event-listener";

export function MeetingTranscript({
  id,
  listKey,
  onRemoved,
}: {
  id: string;
  listKey: QueryKey;
  onRemoved: () => void;
}) {
  const { t } = useLingui();
  const [question, setQuestion] = useState("");
  const [exchange, setExchange] = useState<{ question: string; answer: string }>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const queries = useSpaceQueries();
  const client = useQueryClient();
  const read = queries.meetings.transcript.queryOptions({ input: { id } });
  const transcript = useQuery({ ...read, gcTime: 0, retry: false });
  useEventListener(window, "focus", () => void transcript.refetch({ cancelRefetch: false }));
  const ask = useSave({
    save: (question: string, rpc) => rpc.meetings.ask({ id, question }),
    onSaved: ({ answer }, question) => {
      setExchange({ question, answer });
      setQuestion("");
    },
  });
  const removal = useSave({
    save: (_, rpc) => rpc.meetings.deleteTranscript({ id }),
    stale: [listKey],
    onSaved: () => {
      client.removeQueries({ queryKey: read.queryKey });
      onRemoved();
    },
  });

  if (transcript.error) {
    return <ErrorNotice error={errorDetails(transcript.error, t`Could not load transcript`)} />;
  }
  if (!transcript.data) {
    return (
      <p role="status" className="text-muted-foreground">
        <Trans>Loading transcript…</Trans>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <ol
        aria-label={t`Transcript turns`}
        className="flex max-h-[min(38vh,28rem)] flex-col gap-4 overflow-auto"
      >
        {transcript.data.turns.map((turn, index) => (
          <li key={index}>
            <div className="flex items-center gap-2 text-body-sm">
              <span className="tabular-nums text-muted-foreground">
                {transcriptTime(turn.startMs)}
              </span>
              <span className="font-medium" dir="auto">
                {turn.speaker}
              </span>
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words" dir="auto">
              {turn.text}
            </p>
          </li>
        ))}
      </ol>
      <form
        className="flex flex-col gap-2 border-t pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (question.trim() && !ask.pending && !removal.pending) ask.run(question.trim());
        }}
      >
        {exchange ? (
          <div role="status" className="rounded-lg bg-muted p-3">
            <p className="font-medium" dir="auto">
              {exchange.question}
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words" dir="auto">
              {exchange.answer}
            </p>
          </div>
        ) : null}
        <label htmlFor="meeting-question" className="font-medium">
          <Trans>Ask about this meeting</Trans>
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="meeting-question"
            autoComplete="off"
            value={question}
            disabled={ask.pending || removal.pending}
            onChange={(event) => {
              ask.reset();
              setQuestion(event.target.value);
            }}
          />
          <Button type="submit" disabled={ask.pending || removal.pending || !question.trim()}>
            {ask.pending ? <Trans>Asking…</Trans> : <Trans>Ask</Trans>}
          </Button>
        </div>
        {ask.error ? (
          <ErrorNotice error={errorDetails(ask.error, t`Could not answer the question`)} />
        ) : null}
      </form>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start text-muted-foreground"
        disabled={ask.pending || removal.pending}
        onClick={() => {
          removal.reset();
          setConfirmOpen(true);
        }}
      >
        <Trans>Delete transcript</Trans>
      </Button>
      {confirmOpen ? (
        <ConfirmDialog
          title={t`Delete this transcript?`}
          confirmLabel={t`Delete transcript`}
          description={t`The transcript will be removed from Rakazo.`}
          busy={removal.pending}
          error={
            removal.error && errorDetails(removal.error, t`Could not delete transcript`).message
          }
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => removal.run()}
        />
      ) : null}
    </div>
  );
}
