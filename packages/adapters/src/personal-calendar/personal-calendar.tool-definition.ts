import type { ConnectorTool } from "@rakazo/adapter-kit";
import { CalendarActions } from "@rakazo/contracts";
import * as z from "zod";

const descriptions: Record<keyof typeof CalendarActions, string> = {
  list_calendars:
    "List calendars and their account identities and write permissions. Choose device for the owner's current phone or connected for cloud accounts.",
  list_calendar_events:
    "List upcoming calendar occurrences in a date/time window of up to 31 days. Use an exact calendar reference returned by list_calendars.",
  create_calendar_event:
    "Create an event in one explicitly chosen writable calendar. Use list_calendars for its exact reference. Timed events use offset ISO timestamps and an IANA time zone. All-day events use dates with an exclusive end. Supports daily or weekly recurrence. If the selected calendar is unavailable, ask before choosing another. If the result is uncertain, check before trying again.",
  list_reminders:
    "List reminder lists on the owner's phone, or list incomplete reminders inside one exact list. Use this to resolve the list and reminder before changing one.",
  create_reminder:
    "Create a reminder in exactly one writable list on the owner's phone. Use list_reminders to resolve the list.",
  complete_reminder:
    "Complete one reminder in exactly one list on the owner's phone. Use list_reminders to resolve both ids.",
};

export const personalCalendarTools: ConnectorTool[] = Object.entries(CalendarActions).map(
  ([name, schema]) => ({
    name,
    description: descriptions[name as keyof typeof CalendarActions],
    inputSchema: z.toJSONSchema(schema, { io: "input" }),
    readOnly: name.startsWith("list_"),
  }),
);
