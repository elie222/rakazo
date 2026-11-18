import { oc } from "@orpc/contract";
import { z } from "zod";
import { MeetingPlatformSchema } from "./meetings.js";

export const MEETING_CALENDAR_CALLBACK_PATH = "/api/meetings/calendar/oauth/callback";
export const MOBILE_MEETING_CALENDAR_CALLBACK_URL = "rakazo://meeting-calendar-oauth";

const bot = z.object({ botId: z.string().min(1).max(128) });
const event = bot.extend({ eventId: z.string().min(1).max(256) });
const upcoming = z.object({
  id: z.string(),
  title: z.string(),
  startsAt: z.number(),
  endsAt: z.number(),
  platform: MeetingPlatformSchema,
  recurring: z.boolean(),
  selection: z.enum(["none", "once", "series", "skipped", "another_bot"]),
  scheduled: z.boolean(),
});

export const meetingCalendarRpc = {
  meetingCalendar: {
    upcoming: oc.input(bot).output(
      z.object({
        available: z.boolean(),
        connected: z.boolean(),
        connecting: z.boolean().optional(),
        calendarLabel: z.string(),
        events: z.array(upcoming),
      }),
    ),
    begin: oc.input(bot.extend({ client: z.enum(["web", "mobile"]) })).output(
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
    select: oc.input(event.extend({ scope: z.enum(["once", "series"]) })).output(z.void()),
    skip: oc.input(event).output(z.void()),
    removeSeries: oc.input(event).output(z.void()),
    disconnect: oc.input(z.object({})).output(z.void()),
  },
};
