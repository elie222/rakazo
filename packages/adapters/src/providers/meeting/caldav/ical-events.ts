import ICAL from "ical.js";

/** One occurrence of a calendar object, before it is given a provider event ID. */
export interface ICalOccurrence {
  uid: string;
  /** The occurrence's original start (RECURRENCE-ID) in UTC, or null for a one-off event. */
  recurrenceId: string | null;
  recurring: boolean;
  title: string;
  startsAt: Date;
  endsAt: Date;
  meetingUrl: string | null;
  cancelled: boolean;
  declined: boolean;
}

export interface ICalWindow {
  from: Date;
  through: Date;
}

/** Recognizes a supported meeting link in free text. Returns the link as written. */
export type MeetingLinkMatcher = (candidate: string) => boolean;

const MAX_OCCURRENCES_SCANNED = 20_000;
const MAX_CALENDAR_OBJECT_CHARS = 1024 * 1024;
const URL_PATTERN = /https:\/\/[^\s<>"'\\]+/giu;
// Calendars often move a single occurrence of a series by up to a few days.
const MOVED_OCCURRENCE_MARGIN_MS = 7 * 24 * 60 * 60_000;

function zoneOffsetMs(utc: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(utc));
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  const local = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return local - Math.floor(utc / 1000) * 1000;
}

/**
 * Some servers name an IANA zone in TZID without sending its VTIMEZONE. ical.js then reads
 * the time as floating, so convert it with the runtime's zone data instead.
 */
export function toUtc(time: ICAL.Time): Date {
  // ical.js keeps the unresolved TZID here; its typings omit it.
  const tzid = (time as ICAL.Time & { timezone?: unknown }).timezone;
  if (typeof tzid !== "string") return time.toJSDate();
  if (time.isDate || time.zone?.tzid !== "floating" || !tzid) return time.toJSDate();
  const wall = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  try {
    const guess = wall - zoneOffsetMs(wall, tzid);
    return new Date(wall - zoneOffsetMs(guess, tzid));
  } catch (error) {
    if (error instanceof RangeError) return time.toJSDate();
    throw error;
  }
}

export function utcRecurrenceId(time: ICAL.Time): string {
  return toUtc(time).toISOString();
}

function textValue(component: ICAL.Component, name: string): string {
  const value = component.getFirstPropertyValue(name);
  return typeof value === "string" ? value : "";
}

/** Finds the first supported meeting link in the fields calendar apps use for joining details. */
export function findMeetingUrl(component: ICAL.Component, matches: MeetingLinkMatcher) {
  const fields = [
    textValue(component, "url"),
    ...component.getAllProperties("conference").map((property) => {
      const value = property.getFirstValue();
      return typeof value === "string" ? value : "";
    }),
    textValue(component, "x-google-conference"),
    textValue(component, "location"),
    textValue(component, "description"),
  ];
  for (const field of fields) {
    for (const [raw] of field.matchAll(URL_PATTERN)) {
      const candidate = raw.replace(/[).,;:!?\]}>]+$/u, "");
      if (matches(candidate)) return candidate;
    }
  }
  return null;
}

function declinedBy(component: ICAL.Component, emails: ReadonlySet<string>) {
  if (!emails.size) return false;
  return component.getAllProperties("attendee").some((attendee) => {
    const value = attendee.getFirstValue();
    if (typeof value !== "string") return false;
    const email = value
      .replace(/^mailto:/iu, "")
      .trim()
      .toLowerCase();
    const status = attendee.getParameter("partstat");
    return emails.has(email) && typeof status === "string" && status.toUpperCase() === "DECLINED";
  });
}

function occurrence(
  item: ICAL.Event,
  startDate: ICAL.Time,
  endDate: ICAL.Time,
  recurrenceId: ICAL.Time | null,
  recurring: boolean,
  matches: MeetingLinkMatcher,
  emails: ReadonlySet<string>,
): ICalOccurrence | null {
  // All-day entries are not meetings a participant can join at a set time.
  if (startDate.isDate) return null;
  const component = item.component;
  const status = textValue(component, "status").toUpperCase();
  return {
    uid: item.uid,
    recurrenceId: recurrenceId ? utcRecurrenceId(recurrenceId) : null,
    recurring,
    title: (item.summary ?? "").trim(),
    startsAt: toUtc(startDate),
    endsAt: toUtc(endDate),
    meetingUrl: findMeetingUrl(component, matches),
    cancelled: status === "CANCELLED",
    declined: declinedBy(component, emails),
  };
}

/**
 * Expands the events in one calendar object into the occurrences that start in a window.
 * Overridden occurrences (RECURRENCE-ID) replace the series' generated ones, and EXDATE
 * removes them, following RFC 5545. Malformed objects yield nothing.
 */
export function expandCalendarObject(
  text: string,
  window: ICalWindow,
  matches: MeetingLinkMatcher,
  attendeeEmails: readonly string[] = [],
): ICalOccurrence[] {
  if (text.length > MAX_CALENDAR_OBJECT_CHARS) return [];
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(text) as unknown[]);
  } catch {
    return [];
  }
  const emails = new Set(attendeeEmails.map((email) => email.trim().toLowerCase()));
  const vevents = root.getAllSubcomponents("vevent");
  const byUid = new Map<string, { master?: ICAL.Component; exceptions: ICAL.Component[] }>();
  for (const vevent of vevents) {
    const uid = textValue(vevent, "uid");
    if (!uid) continue;
    const group = byUid.get(uid) ?? { exceptions: [] };
    if (vevent.hasProperty("recurrence-id")) group.exceptions.push(vevent);
    else group.master ??= vevent;
    byUid.set(uid, group);
  }

  const results: ICalOccurrence[] = [];
  const inWindow = (value: ICalOccurrence | null): value is ICalOccurrence =>
    value !== null && value.startsAt >= window.from && value.startsAt <= window.through;

  for (const { master, exceptions } of byUid.values()) {
    try {
      if (!master) {
        // An invitation to single occurrences arrives without its series.
        for (const exception of exceptions) {
          const event = new ICAL.Event(exception);
          const found = occurrence(
            event,
            event.startDate,
            event.endDate,
            event.recurrenceId,
            true,
            matches,
            emails,
          );
          if (inWindow(found)) results.push(found);
        }
        continue;
      }
      const event = new ICAL.Event(master, { exceptions });
      if (!event.isRecurring()) {
        const found = occurrence(
          event,
          event.startDate,
          event.endDate,
          null,
          false,
          matches,
          emails,
        );
        if (inWindow(found)) results.push(found);
        continue;
      }
      const iterator = event.iterator();
      const stopAfter = window.through.getTime() + MOVED_OCCURRENCE_MARGIN_MS;
      const earliest = window.from.getTime() - MOVED_OCCURRENCE_MARGIN_MS;
      for (let scanned = 0; scanned < MAX_OCCURRENCES_SCANNED; scanned++) {
        const next = iterator.next();
        if (!next) break;
        const original = toUtc(next).getTime();
        if (original > stopAfter) break;
        if (original < earliest) continue;
        const details = event.getOccurrenceDetails(next);
        const found = occurrence(
          details.item,
          details.startDate,
          details.endDate,
          details.recurrenceId,
          true,
          matches,
          emails,
        );
        if (inWindow(found)) results.push(found);
      }
    } catch {
      // One unreadable event should not hide the rest of the calendar.
    }
  }
  return results;
}
