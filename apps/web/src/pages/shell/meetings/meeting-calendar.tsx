import { Trans, useLingui } from "@lingui/react/macro";
import { showCalendarStatusRetry } from "@rakazo/core";
import type { MeetingCalendarAction } from "@rakazo/i18n/meeting";
import {
  meetingCalendarActionLabel,
  meetingCalendarActions,
  meetingCalendarSharingNotice,
  meetingCalendarStatusLabel,
  meetingPlatformLabel,
} from "@rakazo/i18n/meeting";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  SectionHeading,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ChevronDown, Ellipsis } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { connectMeetingCalendar } from "../../../lib/integrations/meeting-calendar-connect";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import { errorDetails } from "../../../lib/query/user-error";
import { useEventListener } from "../../../lib/use-event-listener";

type Selection = { eventId: string; action: MeetingCalendarAction };
type Action = Selection | { action: "connect" | "disconnect" };

export function MeetingCalendar({
  botId,
  initiallyOpen,
}: {
  botId: string;
  initiallyOpen: boolean;
}) {
  const { t, i18n } = useLingui();
  const [open, setOpen] = useState(initiallyOpen);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const queries = useSpaceQueries();
  const read = queries.meetingCalendar.upcoming.queryOptions({ input: { botId } });
  const availability = useQuery(queries.meetingCalendar.status.queryOptions({ input: { botId } }));
  const available = availability.data?.available ?? false;
  const list = useQuery({ ...read, enabled: open && available });
  useEventListener(open && available ? window : null, "focus", () => {
    void list.refetch({ cancelRefetch: false });
  });
  const connect = useRef<AbortController>(undefined);
  useEffect(() => () => connect.current?.abort(), []);
  const save = useSave({
    stale: [read.queryKey, queries.meetings.list.queryKey({ input: { botId } })],
    save: async (input: Action, rpc) => {
      switch (input.action) {
        case "connect": {
          const controller = new AbortController();
          connect.current = controller;
          try {
            return await connectMeetingCalendar(rpc, botId, controller.signal);
          } finally {
            if (connect.current === controller) connect.current = undefined;
          }
        }
        case "disconnect":
          return rpc.meetingCalendar.disconnect({});
        case "skip":
          return rpc.meetingCalendar.skip({ botId, eventId: input.eventId });
        case "removeSeries":
          return rpc.meetingCalendar.removeSeries({ botId, eventId: input.eventId });
        default:
          return rpc.meetingCalendar.select({
            botId,
            eventId: input.eventId,
            scope: input.action,
            shareTranscript: true,
          });
      }
    },
  });
  const statusRetry = showCalendarStatusRetry(availability);
  if (!available && !statusRetry) return null;

  const formatter = new Intl.DateTimeFormat(i18n.locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const error = save.error ?? list.error;
  return (
    <section className="border-t border-border pt-3">
      <SectionHeading className="flex items-center">
        <Button
          variant="ghost"
          className="-ms-2 justify-start"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <CalendarDays className="size-4" />
          <Trans>Auto-join</Trans>
          <ChevronDown className={open ? "size-4 rotate-180" : "size-4"} />
        </Button>
      </SectionHeading>
      {open ? (
        <div className="flex flex-col gap-3 pt-2">
          {statusRetry ? (
            <ErrorNotice error={errorDetails(availability.error, t`Could not load calendar`)}>
              <Button
                variant="outline"
                size="sm"
                disabled={availability.isFetching}
                onClick={() => void availability.refetch()}
              >
                <Trans>Try again</Trans>
              </Button>
            </ErrorNotice>
          ) : null}
          {error ? <ErrorNotice error={errorDetails(error, t`Could not update calendar`)} /> : null}
          {!list.data ? (
            list.isPending && available ? (
              <p role="status">
                <Trans>Loading calendar…</Trans>
              </p>
            ) : null
          ) : list.data.connected ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <SectionHeading variant="label">
                  <Trans>Upcoming meetings</Trans>
                </SectionHeading>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={t`Calendar options`}
                    disabled={save.pending}
                    render={<Button variant="ghost" size="icon-sm" />}
                  >
                    <Ellipsis className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-max">
                    <DropdownMenuItem onClick={() => setConfirmDisconnect(true)}>
                      <Trans>Disconnect calendar</Trans>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {list.data.events.length ? (
                <ul className="divide-y divide-border">
                  {list.data.events.map((event) => {
                    const title = event.title || t`Untitled meeting`;
                    const status = meetingCalendarStatusLabel(event) ?? t`Choose`;
                    const actions = meetingCalendarActions(event);
                    const sharingNotice = meetingCalendarSharingNotice(actions);
                    return (
                      <li key={event.id} className="flex items-center justify-between gap-4 py-2">
                        <div className="min-w-0">
                          <div className="truncate font-medium">{title}</div>
                          <div className="flex flex-wrap gap-x-2 text-label text-muted-foreground">
                            <time dateTime={new Date(event.startsAt).toISOString()}>
                              {formatter.format(event.startsAt)}
                            </time>
                            <span>{meetingPlatformLabel(event.platform)}</span>
                          </div>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            disabled={save.pending}
                            aria-label={t`${title}, ${status}`}
                            render={<Button variant="outline" size="sm" />}
                          >
                            {status}
                            <ChevronDown className="size-3" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-max">
                            <DropdownMenuGroup>
                              {sharingNotice ? (
                                <DropdownMenuLabel className="max-w-52 whitespace-normal">
                                  {sharingNotice}
                                </DropdownMenuLabel>
                              ) : null}
                              {actions.map((action) => (
                                <DropdownMenuItem
                                  key={action}
                                  onClick={() => save.run({ action, eventId: event.id })}
                                >
                                  {meetingCalendarActionLabel(action)}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-body text-muted-foreground">
                  <Trans>No upcoming meetings</Trans>
                </p>
              )}
            </>
          ) : list.data.disconnecting || list.data.connecting ? (
            <>
              <p role="status" className="text-body text-muted-foreground">
                {list.data.disconnecting ? t`Disconnecting calendar…` : t`Connecting calendar…`}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                disabled={save.pending}
                onClick={() => save.run({ action: "disconnect" })}
              >
                {list.data.disconnecting ? t`Try again` : t`Disconnect calendar`}
              </Button>
            </>
          ) : (
            <>
              <p className="text-body text-muted-foreground">
                <Trans>
                  Connecting shares calendar access with the meeting service. You choose which
                  meetings your bot joins.
                </Trans>
              </p>
              <Button
                className="self-start"
                size="sm"
                disabled={save.pending}
                onClick={() => save.run({ action: "connect" })}
              >
                <Trans>Connect {list.data.calendarLabel}</Trans>
              </Button>
            </>
          )}
        </div>
      ) : null}
      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Disconnect calendar?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>Your bot will be removed from upcoming meetings on this calendar.</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={save.pending}
              onClick={() => {
                setConfirmDisconnect(false);
                save.run({ action: "disconnect" });
              }}
            >
              <Trans>Disconnect calendar</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
