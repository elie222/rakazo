import { Trans, useLingui } from "@lingui/react/macro";
import { meetingPlatformLabel } from "@rakazo/i18n/meeting";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  SectionHeading,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ChevronDown, Ellipsis } from "lucide-react";
import { useState } from "react";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { desktopBridge } from "../../../lib/platform/desktop";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import { errorDetails } from "../../../lib/query/user-error";
import { useEventListener } from "../../../lib/use-event-listener";

type Selection = { eventId: string; action: "once" | "series" | "skip" | "removeSeries" };
type Action = Selection | { action: "connect" | "disconnect" };

export function MeetingCalendar({ botId }: { botId: string }) {
  const { t, i18n } = useLingui();
  const [open, setOpen] = useState(false);
  const queries = useSpaceQueries();
  const read = queries.meetingCalendar.upcoming.queryOptions({ input: { botId } });
  const list = useQuery(read);
  useEventListener(open ? window : null, "focus", () => {
    void list.refetch({ cancelRefetch: false });
  });
  const save = useSave({
    stale: [read.queryKey, queries.meetings.list.queryKey({ input: { botId } })],
    save: async (input: Action, rpc) => {
      switch (input.action) {
        case "connect": {
          const started = await rpc.meetingCalendar.begin({ botId, client: "web" });
          if (desktopBridge()) {
            window.open(started.authorizationUrl, "_blank", "noopener,noreferrer");
          } else {
            window.location.assign(started.authorizationUrl);
          }
          return;
        }
        case "disconnect":
          return rpc.meetingCalendar.disconnect({});
        case "skip":
          return rpc.meetingCalendar.skip({ botId, eventId: input.eventId });
        case "removeSeries":
          return rpc.meetingCalendar.removeSeries({ botId, eventId: input.eventId });
        default:
          return rpc.meetingCalendar.select({ botId, eventId: input.eventId, scope: input.action });
      }
    },
  });
  if (!list.data?.available) return null;

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
          {error ? <ErrorNotice error={errorDetails(error, t`Could not update calendar`)} /> : null}
          {list.data.connected ? (
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
                    <DropdownMenuItem onClick={() => save.run({ action: "disconnect" })}>
                      <Trans>Disconnect calendar</Trans>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {list.data.events.length ? (
                <ul className="divide-y divide-border">
                  {list.data.events.map((event) => {
                    const title = event.title || t`Untitled meeting`;
                    const status =
                      event.selection === "another_bot"
                        ? t`Another bot`
                        : event.selection === "skipped"
                          ? t`Skipped`
                          : event.scheduled
                            ? t`Scheduled`
                            : event.selection === "none"
                              ? t`Choose`
                              : t`Selected`;
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
                            aria-label={t`Schedule for ${title}`}
                            render={<Button variant="outline" size="sm" />}
                          >
                            {status}
                            <ChevronDown className="size-3" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-max">
                            <DropdownMenuItem
                              onClick={() => save.run({ action: "once", eventId: event.id })}
                            >
                              <Trans>Join this meeting</Trans>
                            </DropdownMenuItem>
                            {event.recurring ? (
                              <DropdownMenuItem
                                onClick={() => save.run({ action: "series", eventId: event.id })}
                              >
                                <Trans>Join this series</Trans>
                              </DropdownMenuItem>
                            ) : null}
                            {event.selection === "once" || event.selection === "series" ? (
                              <DropdownMenuItem
                                onClick={() => save.run({ action: "skip", eventId: event.id })}
                              >
                                <Trans>Skip this meeting</Trans>
                              </DropdownMenuItem>
                            ) : null}
                            {event.selection === "series" ? (
                              <DropdownMenuItem
                                onClick={() =>
                                  save.run({ action: "removeSeries", eventId: event.id })
                                }
                              >
                                <Trans>Stop joining this series</Trans>
                              </DropdownMenuItem>
                            ) : null}
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
          ) : list.data.connecting ? (
            <>
              <p role="status" className="text-body text-muted-foreground">
                <Trans>Connecting calendar…</Trans>
              </p>
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                disabled={save.pending}
                onClick={() => save.run({ action: "disconnect" })}
              >
                <Trans>Disconnect calendar</Trans>
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
    </section>
  );
}
