import { oc } from "@orpc/contract";
import { z } from "zod";
import { MeetingPlatformSchema } from "./meetings.js";

export const MEETING_CALENDAR_CALLBACK_PATH = "/api/meetings/calendar/oauth/callback";
export const MEETING_CALENDAR_RETURN_PARAM = "meeting-calendar";
export const DESKTOP_MEETING_CALENDAR_LAUNCH_PATH = "/api/meetings/calendar/oauth/desktop";
export const DESKTOP_MEETING_CALENDAR_DENIED = "rakazo-calendar-denied";
export const DESKTOP_MEETING_CALENDAR_UNAVAILABLE = "rakazo-calendar-unavailable";
export const DESKTOP_MEETING_CALENDAR_FAILED = "rakazo-calendar-failed";
export const MOBILE_MEETING_CALENDAR_CALLBACK_URL = "rakazo://meeting-calendar-oauth";

export const MeetingCalendarOAuthErrorSchema = z.enum(["denied", "unavailable", "failed"]);
export type MeetingCalendarOAuthError = z.infer<typeof MeetingCalendarOAuthErrorSchema>;

const bot = z.object({ botId: z.string().min(1).max(128) });
const event = bot.extend({ eventId: z.string().min(1).max(256) });
const MeetingCalendarOccurrenceSchema = z.object({
  id: z.string(),
  title: z.string(),
  startsAt: z.number(),
  endsAt: z.number(),
  platform: MeetingPlatformSchema,
  recurring: z.boolean(),
  selection: z.enum(["none", "once", "series", "skipped", "another_bot"]),
  scheduled: z.boolean(),
  quotaReached: z.boolean().optional(),
});

const MeetingCalendarUpcomingSchema = z.object({
  available: z.boolean(),
  connected: z.boolean(),
  connecting: z.boolean().optional(),
  disconnecting: z.boolean().optional(),
  calendarLabel: z.string(),
  events: z.array(MeetingCalendarOccurrenceSchema),
});
export type MeetingCalendarUpcoming = z.infer<typeof MeetingCalendarUpcomingSchema>;

export const meetingCalendarRpc = {
  meetingCalendar: {
    status: oc.input(bot).output(z.object({ available: z.boolean() })),
    upcoming: oc.input(bot).output(MeetingCalendarUpcomingSchema),
    begin: oc
      .input(
        z.discriminatedUnion("client", [
          bot.extend({ client: z.enum(["web", "mobile"]) }),
          bot.extend({
            client: z.literal("desktop"),
            loopbackPort: z.number().int().min(49_152).max(65_535),
          }),
        ]),
      )
      .output(
        z.object({
          authorizationUrl: z.string(),
          state: z.string(),
        }),
      ),
    complete: oc
      .input(
        z.object({
          state: z.string().min(1).max(128),
          code: z.string().min(1).max(8192),
        }),
      )
      .output(z.void()),
    select: oc
      .input(
        event.extend({
          scope: z.enum(["once", "series"]),
          shareTranscript: z.boolean().optional(),
        }),
      )
      .output(z.void()),
    skip: oc.input(event).output(z.void()),
    removeSeries: oc.input(event).output(z.void()),
    disconnect: oc.input(z.object({})).output(z.void()),
  },
};
