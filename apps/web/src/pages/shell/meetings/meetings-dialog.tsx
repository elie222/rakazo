import { Trans, useLingui } from "@lingui/react/macro";
import { canLeaveMeeting } from "@rakazo/contracts";
import { meetingPlatformLabel, meetingStatusLabel, meetingTime } from "@rakazo/i18n/meeting";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import { errorDetails } from "../../../lib/query/user-error";
import { useEventListener } from "../../../lib/use-event-listener";
import { MeetingCalendar } from "./meeting-calendar";
import { MeetingTranscript } from "./meeting-transcript";

export default function MeetingsDialog({
  botId,
  showCalendar,
  onClose,
}: {
  botId: string;
  showCalendar: boolean;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [selected, select] = useState<string>();
  const [url, setUrl] = useState("");
  const queries = useSpaceQueries();
  const read = queries.meetings.list.queryOptions({ input: { botId } });
  const list = useQuery(read);
  useEventListener(window, "focus", () => void list.refetch({ cancelRefetch: false }));
  const join = useSave({
    save: (url: string, rpc) => rpc.meetings.join({ botId, url, shareTranscript: true }),
    stale: [read.queryKey],
    onSaved: () => setUrl(""),
  });
  const leave = useSave({
    save: (id: string, rpc) => rpc.meetings.leave({ id }),
    stale: [read.queryKey],
  });
  const busy = join.pending || leave.pending;
  const activeTranscript = list.error
    ? undefined
    : list.data?.meetings.find((meeting) => meeting.id === selected && meeting.transcriptAvailable);
  const error = join.error ?? leave.error ?? list.error;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="md">
        <DialogHeader className="flex-row items-center gap-2 px-6 pt-6 pe-14 pb-4">
          {activeTranscript ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t`Back to meetings`}
              onClick={() => select(undefined)}
            >
              <ArrowLeft className="size-4 rtl:rotate-180" />
            </Button>
          ) : null}
          <DialogTitle>{activeTranscript ? t`Transcript` : t`Meetings`}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 overflow-auto px-6 pb-6">
          {activeTranscript ? (
            <MeetingTranscript
              key={activeTranscript.id}
              id={activeTranscript.id}
              onRemoved={() => select(undefined)}
              listKey={read.queryKey}
            />
          ) : (
            <div className="flex flex-col gap-5">
              {list.data?.enabled ? (
                <form
                  className="flex flex-col gap-2"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (url.trim() && !busy) join.run(url.trim());
                  }}
                >
                  <label htmlFor="meeting-link" className="font-medium">
                    <Trans>Meeting link</Trans>
                  </label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="meeting-link"
                      type="url"
                      aria-describedby="meeting-capture-notice"
                      autoComplete="off"
                      value={url}
                      disabled={busy}
                      onChange={(event) => {
                        join.reset();
                        setUrl(event.target.value);
                      }}
                    />
                    <Button size="lg" type="submit" disabled={busy || !url.trim()}>
                      <Trans>Join meeting</Trans>
                    </Button>
                  </div>
                  <p id="meeting-capture-notice" className="text-body-sm text-muted-foreground">
                    <Trans>
                      Get permission to record and share the transcript with this Space.
                    </Trans>
                  </p>
                </form>
              ) : list.isPending ? (
                <p role="status" className="text-muted-foreground">
                  <Trans>Loading meetings…</Trans>
                </p>
              ) : list.data ? (
                <p className="text-muted-foreground">
                  <Trans>Meeting joins are unavailable.</Trans>
                </p>
              ) : null}
              {error ? (
                <ErrorNotice error={errorDetails(error, t`Could not update meetings`)} />
              ) : null}
              {!list.error && list.data?.meetings.length ? (
                <ul aria-label={t`Recent meetings`} className="divide-y border-t">
                  {list.data.meetings.map((meeting) => {
                    const canRead = meeting.transcriptAvailable;
                    const canLeave = canLeaveMeeting(meeting.status);
                    return (
                      <li key={meeting.id} className="flex items-center justify-between gap-3 py-3">
                        <div className="min-w-0">
                          <p className="font-medium">{meetingPlatformLabel(meeting.platform)}</p>
                          {!canLeave ? (
                            <p className="text-body-sm text-muted-foreground">
                              {meetingTime(meeting.createdAt)}
                            </p>
                          ) : null}
                          {canRead || meeting.error ? null : (
                            <p role="status" className="text-body-sm text-muted-foreground">
                              {meetingStatusLabel(meeting.status)}
                            </p>
                          )}
                          {meeting.error ? (
                            <p className="text-body-sm text-destructive">{meeting.error}</p>
                          ) : null}
                        </div>
                        {canRead ? (
                          <Button variant="ghost" onClick={() => select(meeting.id)}>
                            <Trans>View transcript</Trans>
                            <ChevronRight className="size-4 rtl:rotate-180" />
                          </Button>
                        ) : canLeave ? (
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() => leave.run(meeting.id)}
                          >
                            <Trans>Leave meeting</Trans>
                          </Button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {list.data?.enabled ? (
                <MeetingCalendar botId={botId} initiallyOpen={showCalendar} />
              ) : null}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
