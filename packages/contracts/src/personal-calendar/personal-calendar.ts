import * as z from "zod";

const key = z.string().min(1).max(512);
const title = z.string().trim().min(1).max(300);
const label = z.string().max(512);
const instant = z.iso.datetime({ offset: true });
const day = z.iso.date();
const zone = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return !/^[+-]/.test(value);
    } catch {
      return false;
    }
  }, "Use an IANA time zone.");

export const CalendarSource = z.enum(["device", "connected"]);
export const CalendarRef = z.strictObject({
  source: CalendarSource,
  accountId: key,
  calendarId: key,
});
export const CalendarInfo = CalendarRef.extend({
  name: label,
  accountName: label,
  writable: z.boolean(),
  timeZone: label.optional(),
});

const Window = z.strictObject({ from: instant, to: instant }).refine(({ from, to }) => {
  const length = Date.parse(to) - Date.parse(from);
  return length > 0 && length <= 31 * 86_400_000;
}, "Choose a positive range of at most 31 days.");

const EventTiming = z
  .discriminatedUnion("allDay", [
    z.strictObject({ allDay: z.literal(false), start: instant, end: instant, timeZone: zone }),
    z.strictObject({ allDay: z.literal(true), start: day, end: day, timeZone: zone }),
  ])
  .refine(
    ({ allDay, start, end }) => (allDay ? start < end : Date.parse(start) < Date.parse(end)),
    "The end must follow the start. All-day end dates are exclusive.",
  );

export const EventDraft = z.strictObject({
  title,
  timing: EventTiming,
  location: z.string().max(500).optional(),
  notes: z.string().max(4_000).optional(),
  recurrence: z
    .strictObject({
      frequency: z.enum(["daily", "weekly"]),
      interval: z.number().int().min(1).max(99),
      count: z.number().int().min(2).max(999).optional(),
    })
    .optional(),
});

const Occurrence = z.object({
  id: key,
  calendar: CalendarRef,
  title: label,
  start: z.union([instant, day]),
  end: z.union([instant, day]),
  allDay: z.boolean(),
  timeZone: label.optional(),
  endTimeZone: label.optional(),
  recurrence: z
    .object({
      seriesId: key,
      originalStart: z.union([instant, day]).optional(),
      exception: z.boolean().optional(),
    })
    .optional(),
});

const ReminderList = z.strictObject({ accountId: key, listId: key });
const ReminderListInfo = ReminderList.extend({
  name: label,
  accountName: label,
  writable: z.boolean(),
});

export const CalendarActions = {
  list_calendars: z.strictObject({ source: CalendarSource, accountId: key.optional() }),
  list_calendar_events: z.strictObject({ calendar: CalendarRef, window: Window }),
  create_calendar_event: z.strictObject({ calendar: CalendarRef, event: EventDraft }),
  list_reminders: z.strictObject({ list: ReminderList.optional() }),
  create_reminder: z.strictObject({
    list: ReminderList,
    title,
    notes: z.string().max(4_000).optional(),
    due: z.strictObject({ at: instant, timeZone: zone }).optional(),
  }),
  complete_reminder: z.strictObject({ list: ReminderList, reminderId: key }),
};

export const CalendarOperation = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list_calendars"), input: CalendarActions.list_calendars }),
  z.strictObject({
    action: z.literal("list_calendar_events"),
    input: CalendarActions.list_calendar_events,
  }),
  z.strictObject({
    action: z.literal("create_calendar_event"),
    input: CalendarActions.create_calendar_event,
  }),
  z.strictObject({ action: z.literal("list_reminders"), input: CalendarActions.list_reminders }),
  z.strictObject({ action: z.literal("create_reminder"), input: CalendarActions.create_reminder }),
  z.strictObject({
    action: z.literal("complete_reminder"),
    input: CalendarActions.complete_reminder,
  }),
]);
// Keep the discriminant linked to its input for callers that narrow by action.
export type CalendarOperation = z.infer<typeof CalendarOperation>;

export const CalendarResults = {
  list_calendars: z.object({
    calendars: z.array(CalendarInfo).max(200),
    truncated: z.boolean().optional(),
  }),
  list_calendar_events: z.object({
    events: z.array(Occurrence).max(100),
    truncated: z.boolean().optional(),
  }),
  create_calendar_event: z.object({ id: key, calendar: CalendarRef }),
  list_reminders: z.object({
    lists: z.array(ReminderListInfo).max(200),
    reminders: z
      .array(
        z.object({
          id: key,
          title: label,
          due: z.union([instant, day]).optional(),
          timeZone: label.optional(),
        }),
      )
      .max(100)
      .optional(),
    truncated: z.boolean().optional(),
  }),
  create_reminder: z.object({ id: key, list: ReminderList }),
  complete_reminder: z.object({ id: key, list: ReminderList }),
};
export type CalendarResult<Action extends keyof typeof CalendarActions> = z.infer<
  (typeof CalendarResults)[Action]
>;
export type CalendarRef = z.infer<typeof CalendarRef>;
export type CalendarInfo = z.infer<typeof CalendarInfo>;
export type CalendarEvent = z.infer<typeof Occurrence>;

export const CalendarFailure = z.object({
  status: z.enum(["denied", "cancelled", "unavailable", "unsupported", "expired", "uncertain"]),
});
export const CalendarResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), data: z.unknown() }),
  CalendarFailure,
]);
export type CalendarResponse = z.infer<typeof CalendarResponse>;

export function calendarOperationSource(operation: CalendarOperation) {
  if (operation.action === "list_calendars") return operation.input.source;
  return "calendar" in operation.input ? operation.input.calendar.source : "device";
}

export const NativeCalendarDeviceKey = z.uuidv4();

export const NATIVE_CALENDAR_WINDOW_MS = 90_000;

export const NativeCalendarRequest = z.object({
  id: key,
  runId: key,
  threadId: key,
  remainingMs: z.number().int().min(0).max(NATIVE_CALENDAR_WINDOW_MS),
  operation: CalendarOperation,
});
export type NativeCalendarRequest = z.infer<typeof NativeCalendarRequest>;
