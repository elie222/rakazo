import { t } from "@lingui/core/macro";
import type {
  CalendarEvent,
  CalendarInfo,
  CalendarOperation,
  CalendarRef,
  CalendarResponse,
} from "@rakazo/contracts";
import { CalendarResults } from "@rakazo/contracts";
import type { ExpoCalendar as AndroidCalendar, ExpoCalendarEvent } from "expo-calendar";
import { requireOptionalNativeModule } from "expo-modules-core";
import { Alert, Platform } from "react-native";

type Action<Action extends CalendarOperation["action"]> = Extract<
  CalendarOperation,
  { action: Action }
>;
type Draft = Action<"create_calendar_event">["input"]["event"];
type Due = Action<"create_reminder">["input"]["due"];
type Target = { accountId: string; calendarId: string };
type AppleCalendar = {
  calendars(reminders: boolean): Promise<CalendarInfo[]>;
  events(target: Target, from: string, to: string): Promise<Omit<CalendarEvent, "calendar">[]>;
  createEvent(target: Target, draft: Draft): Promise<string>;
  reminders(
    target: Target,
  ): Promise<{ id: string; title: string; due?: string; timeZone?: string }[]>;
  createReminder(
    target: Target,
    title: string,
    notes: string | null,
    due: Due | null,
  ): Promise<string>;
  completeReminder(target: Target, id: string): Promise<string>;
};

const apple = () => requireOptionalNativeModule<AppleCalendar>("RakazoCalendar");
type Prepared = { perform: () => Promise<CalendarResponse> } | CalendarResponse;
const ok = (data: unknown): CalendarResponse => ({ status: "ok", data });
const unavailable: CalendarResponse = { status: "unavailable" };

function androidInfo(calendar: AndroidCalendar): CalendarInfo {
  return {
    source: "device",
    accountId: JSON.stringify([calendar.source.type, calendar.source.name]),
    calendarId: calendar.id,
    name: calendar.title,
    accountName: calendar.source.name,
    timeZone: calendar.timeZone,
    writable: calendar.allowsModifications,
  };
}

function matches({ accountId, calendarId }: Target, target: Target) {
  return accountId === target.accountId && calendarId === target.calendarId;
}

function label(info: CalendarInfo) {
  return info.accountName ? `${info.name}\n${info.accountName}` : info.name;
}

function confirm(title: string, message: string, action: string): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(
      title,
      message,
      [
        { text: t`Cancel`, style: "cancel", onPress: () => resolve(false) },
        { text: action, onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    ),
  );
}

function eventPreview(event: Draft, calendar: CalendarInfo) {
  const { timing, recurrence } = event;
  const formatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    ...(timing.allDay ? {} : { timeStyle: "short" }),
    timeZone: timing.allDay ? "UTC" : timing.timeZone,
  });
  const date = (value: string) => formatter.format(new Date(value));
  // All-day end is exclusive in storage and inclusive in the confirmation.
  const end = timing.allDay
    ? new Date(Date.parse(timing.end) - 86_400_000).toISOString()
    : timing.end;
  const range =
    date(timing.start) === date(end) ? date(timing.start) : `${date(timing.start)} – ${date(end)}`;
  const repeat =
    recurrence &&
    (recurrence.frequency === "daily"
      ? t`Repeats every ${recurrence.interval} day(s)`
      : t`Repeats every ${recurrence.interval} week(s)`);
  return [
    event.title,
    label(calendar),
    range,
    timing.allDay ? t`All day` : timing.timeZone,
    repeat,
    recurrence?.count && t`${recurrence.count} occurrences`,
  ]
    .filter(Boolean)
    .join("\n");
}

function androidOccurrence(event: ExpoCalendarEvent, calendar: CalendarRef): CalendarEvent {
  const date = (value: string | Date) => {
    const iso = new Date(value).toISOString();
    return event.allDay ? iso.slice(0, 10) : iso;
  };
  const seriesId = event.originalId ?? (event.recurrenceRule ? event.id : undefined);
  return {
    id: event.id,
    calendar,
    title: event.title || "",
    start: date(event.startDate),
    end: date(event.endDate),
    allDay: event.allDay,
    timeZone: event.timeZone ?? undefined,
    endTimeZone: event.endTimeZone ?? undefined,
    ...(seriesId && { recurrence: { seriesId, exception: Boolean(event.originalId) } }),
  };
}

export async function prepareDeviceCalendar(
  operation: CalendarOperation,
  current: () => boolean,
): Promise<Prepared> {
  if (!current()) return unavailable;
  const expo = await import("expo-calendar");
  const reminders =
    operation.action === "list_reminders" ||
    operation.action === "create_reminder" ||
    operation.action === "complete_reminder";
  const ios = Platform.OS === "ios" ? apple() : undefined;
  if (reminders && !ios) return { status: "unsupported" };
  const permission = reminders
    ? await expo.getRemindersPermissions()
    : await expo.getCalendarPermissions();
  if (!current()) return unavailable;
  if (!permission.granted) {
    if (!permission.canAskAgain) return { status: "denied" };
    const requested = reminders
      ? await expo.requestRemindersPermissions()
      : await expo.requestCalendarPermissions();
    if (!requested.granted) return { status: "denied" };
  }
  if (!current()) return unavailable;

  const androidCalendars = () => expo.getCalendars(expo.EntityTypes.EVENT);
  const calendars = ios
    ? await ios.calendars(reminders)
    : (await androidCalendars()).map(androidInfo);
  if (!current()) return unavailable;
  if (operation.action === "list_calendars") {
    const { accountId, source } = operation.input;
    if (source !== "device") return unavailable;
    const entries = calendars.filter((info) => !accountId || info.accountId === accountId);
    return {
      perform: async () =>
        ok({ calendars: entries.slice(0, 200), truncated: entries.length > 200 }),
    };
  }

  if (reminders) {
    if (!ios) return unavailable;
    const { list } = operation.input;
    if (!list) {
      const lists = calendars.map(reminderList);
      return {
        perform: async () => ok({ lists: lists.slice(0, 200), truncated: lists.length > 200 }),
      };
    }
    const selected = calendars.find((info) => matches(info, { ...list, calendarId: list.listId }));
    return selected ? prepareReminders(ios, selected, operation, current) : unavailable;
  }

  if (operation.input.calendar.source !== "device") return unavailable;
  const { calendar } = operation.input;
  const info = calendars.find((entry) => matches(entry, calendar));
  if (!info) return unavailable;
  const resolveAndroid = async () =>
    (await androidCalendars()).find(
      (entry) => entry.id === calendar.calendarId && matches(androidInfo(entry), calendar),
    );
  if (operation.action === "list_calendar_events") {
    const { window } = operation.input;
    if (!(await confirm(t`Read calendar events?`, label(info), t`Allow`)))
      return { status: "cancelled" };
    return {
      perform: async () => {
        const android = ios ? undefined : await resolveAndroid();
        if ((!ios && !android) || !current()) return unavailable;
        const events = ios
          ? (await ios.events(calendar, window.from, window.to)).map((event) => ({
              ...event,
              calendar,
            }))
          : (await android!.listEvents(new Date(window.from), new Date(window.to)))
              .filter((event) => event.status !== expo.EventStatus.CANCELED)
              .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime())
              .map((event) => androidOccurrence(event, calendar));
        return ok({ events: events.slice(0, 100), truncated: events.length > 100 });
      },
    };
  }
  if (operation.action !== "create_calendar_event" || !info.writable) return { status: "denied" };
  const { event } = operation.input;
  if (!(await confirm(t`Add calendar event?`, eventPreview(event, info), t`Add`)))
    return { status: "cancelled" };
  return {
    perform: async () => {
      if (ios) return ok({ id: await ios.createEvent(calendar, event), calendar });
      // The external Android editor can pick a different default account. The confirmation
      // above names the exact calendar and the provider insert pins its id.
      const destination = await resolveAndroid();
      if (!destination || !current()) return unavailable;
      if (!destination.allowsModifications) return { status: "denied" };
      const { timing, recurrence } = event;
      const saved = await destination.createEvent({
        title: event.title,
        location: event.location,
        notes: event.notes,
        allDay: timing.allDay,
        startDate: new Date(timing.start),
        endDate: new Date(timing.end),
        // Android stores all-day rows as UTC dates, regardless of the device zone.
        timeZone: timing.allDay ? "UTC" : timing.timeZone,
        endTimeZone: timing.allDay ? "UTC" : timing.timeZone,
        recurrenceRule: recurrence && {
          frequency:
            recurrence.frequency === "daily" ? expo.Frequency.DAILY : expo.Frequency.WEEKLY,
          interval: recurrence.interval,
          occurrence: recurrence.count,
        },
      });
      return saved.calendarId === calendar.calendarId
        ? ok({ id: saved.id, calendar })
        : { status: "uncertain" };
    },
  };
}

function reminderList(info: CalendarInfo) {
  const { accountId, calendarId, accountName, name, writable } = info;
  return { accountId, listId: calendarId, accountName, name, writable };
}

async function prepareReminders(
  ios: AppleCalendar,
  info: CalendarInfo,
  operation: CalendarOperation,
  current: () => boolean,
): Promise<Prepared> {
  const target = { accountId: info.accountId, calendarId: info.calendarId };
  const list = { accountId: info.accountId, listId: info.calendarId };
  if (operation.action === "list_reminders") {
    if (!(await confirm(t`Read reminders?`, label(info), t`Allow`))) return { status: "cancelled" };
    return {
      perform: async () => {
        const reminders = await ios.reminders(target);
        return ok({
          lists: [reminderList(info)],
          reminders: reminders.slice(0, 100),
          truncated: reminders.length > 100,
        });
      },
    };
  }
  if (!info.writable) return { status: "denied" };
  if (operation.action === "create_reminder") {
    const { title, notes, due } = operation.input;
    const when =
      due &&
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: due.timeZone,
      }).format(new Date(due.at));
    const preview = [title, label(info), when, due?.timeZone].filter(Boolean).join("\n");
    if (!(await confirm(t`Add reminder?`, preview, t`Add`))) return { status: "cancelled" };
    return {
      perform: async () =>
        ok({ id: await ios.createReminder(target, title, notes ?? null, due ?? null), list }),
    };
  }
  if (operation.action !== "complete_reminder") return unavailable;
  const { reminderId } = operation.input;
  const reminder = (await ios.reminders(target)).find(({ id }) => id === reminderId);
  if (!reminder || !current()) return unavailable;
  if (!(await confirm(t`Complete reminder?`, `${reminder.title}\n${label(info)}`, t`Complete`)))
    return { status: "cancelled" };
  return { perform: async () => ok({ id: await ios.completeReminder(target, reminderId), list }) };
}

export function validateDeviceCalendarResult(
  operation: CalendarOperation,
  response: CalendarResponse,
): CalendarResponse {
  if (response.status !== "ok") return response;
  const result = CalendarResults[operation.action].safeParse(response.data);
  return result.success
    ? ok(result.data)
    : { status: operation.action.startsWith("list_") ? "unavailable" : "uncertain" };
}
