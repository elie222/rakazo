import { createHash } from "node:crypto";
import type { Composio, ToolProxyParams } from "@composio/core";
import type {
  AdapterContext,
  ConnectedCalendarOperation,
  ConnectedCalendarProvider,
  ConnectedConnector,
} from "@rakazo/adapter-kit";
import type {
  CalendarRef,
  CalendarResponse,
  EventDraft as EventDraftSchema,
} from "@rakazo/contracts";
import { CalendarResults } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import * as z from "zod";
import { isComposioOutage } from "./composio-errors.js";
import { ianaZone } from "./windows-zones.js";

type ProxyRequest = Omit<ToolProxyParams, "connectedAccountId">;
type Proxy = (request: ProxyRequest) => Promise<{ status: number; data?: unknown }>;
type EventDraft = z.infer<typeof EventDraftSchema>;
const text = z.string();
const id = z.string().min(1);
const boolean = z.boolean();
const optionalText = text.nullish();
const pageSize = 100;

const googleCalendar = z.object({
  id,
  summary: optionalText,
  summaryOverride: optionalText,
  accessRole: text,
  timeZone: optionalText,
});
const googleTime = z.object({ date: optionalText, dateTime: optionalText, timeZone: optionalText });
const googleEvent = z.object({
  id,
  summary: optionalText,
  start: googleTime,
  end: googleTime,
  recurringEventId: optionalText,
  originalStartTime: googleTime.optional(),
});
const graphCalendar = z.object({ id, name: text, canEdit: boolean });
const graphTime = z.object({ dateTime: text, timeZone: text });
const graphEvent = z.object({
  id,
  subject: optionalText,
  start: graphTime,
  end: graphTime,
  isAllDay: boolean,
  isCancelled: boolean.optional(),
  seriesMasterId: optionalText,
  type: optionalText,
  originalStart: optionalText,
  originalStartTimeZone: optionalText,
  originalEndTimeZone: optionalText,
});

const googlePage = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item).default([]),
    nextPageToken: text.optional(),
    timeZone: text.optional(),
  });
const graphPage = <T extends z.ZodType>(item: T) =>
  z.object({ value: z.array(item), "@odata.nextLink": text.optional() });

const graphUrl = "https://graph.microsoft.com/v1.0";
const googleUrl = "https://www.googleapis.com/calendar/v3";
const googleWritable = (role: string) => role === "owner" || role === "writer";

export function supportsConnectedCalendar(connection: ConnectedConnector) {
  return (
    connection.externalId.toLowerCase() === "googlecalendar" ||
    connection.externalId.toLowerCase() === "outlook"
  );
}

function pathSegment(value: string) {
  // A dot segment is normalized by URL parsers even if percent-encoded.
  if (value === "." || value === ".." || /[/\\]/u.test(value)) return undefined;
  return encodeURIComponent(value);
}

function query(values: Record<string, string | number>): ProxyRequest["parameters"] {
  return Object.entries(values).map(([name, value]) => ({ in: "query", name, value }));
}

function okay({ status }: { status: number }) {
  return status >= 200 && status < 300;
}

function failure(status: number, write = false): CalendarResponse {
  if (status === 401 || status === 403) return { status: "denied" };
  return {
    status:
      write && (status < 400 || status === 408 || status >= 500) ? "uncertain" : "unavailable",
  };
}

function okayResult<A extends keyof typeof CalendarResults>(
  action: A,
  value: unknown,
): CalendarResponse {
  return { status: "ok", data: CalendarResults[action].parse(value) };
}

/** Uses the owner-checked, exact account reference from the existing connector. */
export function connectedCalendarProvider(
  toolsForAccount: (
    connection: ConnectedConnector,
    accountId: string,
    context: AdapterContext,
  ) => Promise<Pick<Composio["tools"], "proxyExecute"> | undefined>,
): ConnectedCalendarProvider {
  return {
    supportsCalendar: supportsConnectedCalendar,
    calendar: async (connection, operation, writeKey, context) => {
      const connectedAccountId = connection.providerRef?.trim();
      if (!connectedAccountId || !supportsConnectedCalendar(connection))
        return { status: "unavailable" };
      let sentWrite = false;
      try {
        const tools = await toolsForAccount(connection, connectedAccountId, context);
        if (!tools) return { status: "unavailable" };
        const proxy: Proxy = (request) => {
          context.signal.throwIfAborted();
          if (request.method === "POST") sentWrite = true;
          return tools.proxyExecute({ ...request, connectedAccountId }, { signal: context.signal });
        };
        return await executeConnectedCalendar(proxy, connection, operation, writeKey);
      } catch (error) {
        context.signal.throwIfAborted();
        if (!isComposioOutage(error)) throw error;
        getLogger().warn("Connected calendar operation failed", {
          operation: operation.action,
          errorType: error instanceof Error ? error.name : "unknown",
        });
        return { status: sentWrite ? "uncertain" : "unavailable" };
      }
    },
  };
}

export async function executeConnectedCalendar(
  proxy: Proxy,
  connection: ConnectedConnector,
  operation: ConnectedCalendarOperation,
  writeKey: string,
): Promise<CalendarResponse> {
  const target = "calendar" in operation.input ? operation.input.calendar : undefined;
  if (
    !supportsConnectedCalendar(connection) ||
    (target && (target.source !== "connected" || target.accountId !== connection.id))
  )
    return { status: "unavailable" };
  const handler = connection.externalId.toLowerCase() === "googlecalendar" ? google : outlook;
  return handler(proxy, connection, operation, createHash("sha256").update(writeKey).digest("hex"));
}

async function google(
  proxy: Proxy,
  connection: ConnectedConnector,
  operation: ConnectedCalendarOperation,
  eventId: string,
): Promise<CalendarResponse> {
  const ref = (calendarId: string): CalendarRef => ({
    source: "connected",
    accountId: connection.id,
    calendarId,
  });
  if (operation.action === "list_calendars") {
    const response = await proxy({
      method: "GET",
      endpoint: `${googleUrl}/users/me/calendarList`,
      parameters: query({ maxResults: 200 }),
    });
    if (!okay(response)) return failure(response.status);
    const page = googlePage(googleCalendar).parse(response.data);
    return okayResult(operation.action, {
      calendars: page.items.map((item) => ({
        ...ref(item.id),
        name: item.summaryOverride ?? item.summary ?? "",
        timeZone: item.timeZone ?? undefined,
        writable: googleWritable(item.accessRole),
        accountName: connection.displayName,
      })),
      truncated: Boolean(page.nextPageToken),
    });
  }
  const calendar = operation.input.calendar;
  const calendarId = pathSegment(calendar.calendarId);
  if (!calendarId || calendarId.toLowerCase() === "primary") return { status: "unavailable" };
  const endpoint = `${googleUrl}/calendars/${calendarId}/events`;
  if (operation.action === "list_calendar_events") {
    const { from, to } = operation.input.window;
    const response = await proxy({
      method: "GET",
      endpoint,
      parameters: query({
        timeMin: from,
        timeMax: to,
        singleEvents: "true",
        showDeleted: "false",
        orderBy: "startTime",
        maxResults: pageSize,
      }),
    });
    if (!okay(response)) return failure(response.status);
    const page = googlePage(googleEvent).parse(response.data);
    return okayResult(operation.action, {
      events: page.items.map((item) => ({
        id: item.id,
        calendar,
        title: item.summary ?? "",
        start: item.start.date ?? item.start.dateTime,
        end: item.end.date ?? item.end.dateTime,
        allDay: Boolean(item.start.date),
        timeZone: item.start.timeZone ?? (item.start.date ? page.timeZone : undefined),
        endTimeZone: item.end.timeZone ?? (item.end.date ? page.timeZone : undefined),
        ...(item.recurringEventId && {
          recurrence: {
            seriesId: item.recurringEventId,
            originalStart:
              item.originalStartTime?.date ?? item.originalStartTime?.dateTime ?? undefined,
          },
        }),
      })),
      truncated: Boolean(page.nextPageToken),
    });
  }
  const target = await proxy({
    method: "GET",
    endpoint: `${googleUrl}/users/me/calendarList/${calendarId}`,
  });
  if (!okay(target)) return failure(target.status);
  const resolved = googleCalendar.parse(target.data);
  if (resolved.id !== calendar.calendarId || !googleWritable(resolved.accessRole))
    return { status: "denied" };
  const { event } = operation.input;
  const recurrence = event.recurrence;
  const { timing } = event;
  const time = (value: string) =>
    timing.allDay
      ? { date: value, timeZone: timing.timeZone }
      : { dateTime: value, timeZone: timing.timeZone };
  const response = await proxy({
    method: "POST",
    endpoint,
    body: {
      id: eventId,
      summary: event.title,
      start: time(timing.start),
      end: time(timing.end),
      description: event.notes,
      location: event.location,
      ...(recurrence && {
        recurrence: [
          `RRULE:FREQ=${recurrence.frequency.toUpperCase()};INTERVAL=${recurrence.interval}${recurrence.count ? `;COUNT=${recurrence.count}` : ""}`,
        ],
      }),
      extendedProperties: { private: { rakazoRequest: eventId } },
    },
  });
  const saved =
    response.status === 409
      ? await proxy({ method: "GET", endpoint: `${endpoint}/${eventId}` })
      : response;
  if (!okay(saved))
    return response.status === 409 ? { status: "uncertain" } : failure(saved.status, true);
  const result = z
    .object({ id, extendedProperties: z.object({ private: z.object({ rakazoRequest: text }) }) })
    .safeParse(saved.data);
  if (
    !result.success ||
    result.data.id !== eventId ||
    result.data.extendedProperties.private.rakazoRequest !== eventId
  )
    return { status: "uncertain" };
  return okayResult(operation.action, { id: eventId, calendar });
}

function graphLocal(value: string, zone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(value)).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}`;
}

function graphDate(value: string, zone: string) {
  try {
    return graphLocal(value, zone).slice(0, 10);
  } catch (error) {
    // Graph can return a Windows timezone name or a legacy custom zone. Keep
    // its value and the precise boundary instant rather than guessing a date.
    if (error instanceof RangeError) return value;
    throw error;
  }
}

function ambiguousGraphTime(value: string, zone: string, local: string) {
  const time = Date.parse(value);
  const offsetAt = (ms: number) =>
    Date.parse(`${graphLocal(new Date(ms).toISOString(), zone)}Z`) - ms;
  const offset = offsetAt(time);
  const day = 86_400_000;
  return [time - day, time + day].some((other) => {
    const alternate = offsetAt(other);
    return (
      alternate !== offset &&
      graphLocal(new Date(time + offset - alternate).toISOString(), zone) === local
    );
  });
}

function graphUtc(value: z.infer<typeof graphTime>) {
  if (value.timeZone !== "UTC")
    throw new Error("Calendar response did not honor the UTC preference");
  return new Date(`${value.dateTime}Z`).toISOString();
}

function graphRecurrence(event: EventDraft, firstDay: string) {
  const { recurrence, timing } = event;
  if (!recurrence) return undefined;
  const weekday = new Intl.DateTimeFormat("en", { timeZone: "UTC", weekday: "long" })
    .format(new Date(firstDay))
    .toLowerCase();
  return {
    pattern: {
      type: recurrence.frequency,
      interval: recurrence.interval,
      ...(recurrence.frequency === "weekly" && { daysOfWeek: [weekday], firstDayOfWeek: weekday }),
    },
    range: {
      type: recurrence.count ? "numbered" : "noEnd",
      startDate: firstDay,
      recurrenceTimeZone: timing.timeZone,
      ...(recurrence.count && { numberOfOccurrences: recurrence.count }),
    },
  };
}

async function outlook(
  proxy: Proxy,
  connection: ConnectedConnector,
  operation: ConnectedCalendarOperation,
  writeKey: string,
): Promise<CalendarResponse> {
  const endpoint = `${graphUrl}/me/calendars`;
  if (operation.action === "list_calendars") {
    const response = await proxy({ method: "GET", endpoint, parameters: query({ $top: 200 }) });
    if (!okay(response)) return failure(response.status);
    const page = graphPage(graphCalendar).parse(response.data);
    return okayResult(operation.action, {
      calendars: page.value.map((item) => ({
        source: "connected",
        accountId: connection.id,
        calendarId: item.id,
        name: item.name,
        accountName: connection.displayName,
        writable: item.canEdit,
      })),
      truncated: Boolean(page["@odata.nextLink"]),
    });
  }
  const { calendar } = operation.input;
  const calendarId = pathSegment(calendar.calendarId);
  if (!calendarId) return { status: "unavailable" };
  const target = `${endpoint}/${calendarId}`;
  if (operation.action === "list_calendar_events") {
    const { from, to } = operation.input.window;
    const response = await proxy({
      method: "GET",
      endpoint: `${target}/calendarView`,
      parameters: [
        ...(query({
          startDateTime: from,
          endDateTime: to,
          $orderby: "start/dateTime",
          $top: pageSize,
        }) ?? []),
        { in: "header", name: "Prefer", value: 'outlook.timezone="UTC"' },
      ],
    });
    if (!okay(response)) return failure(response.status);
    const page = graphPage(graphEvent).parse(response.data);
    const events = page.value
      .filter((item) => !item.isCancelled)
      .map((item) => {
        const start = graphUtc(item.start);
        const end = graphUtc(item.end);
        const timeZone = ianaZone(item.originalStartTimeZone ?? item.start.timeZone);
        const endTimeZone = ianaZone(item.originalEndTimeZone ?? item.end.timeZone);
        return {
          id: item.id,
          calendar,
          title: item.subject ?? "",
          allDay: item.isAllDay,
          start: item.isAllDay ? graphDate(start, timeZone) : start,
          end: item.isAllDay ? graphDate(end, endTimeZone) : end,
          timeZone,
          endTimeZone,
          ...(item.seriesMasterId && {
            recurrence: {
              seriesId: item.seriesMasterId,
              exception: item.type === "exception",
              originalStart: item.originalStart ?? undefined,
            },
          }),
        };
      });
    return okayResult(operation.action, { events, truncated: Boolean(page["@odata.nextLink"]) });
  }
  const details = await proxy({ method: "GET", endpoint: target });
  if (!okay(details)) return failure(details.status);
  const resolved = graphCalendar.parse(details.data);
  if (resolved.id !== calendar.calendarId || !resolved.canEdit) return { status: "denied" };
  const { event } = operation.input;
  const { timing } = event;
  const local = (value: string) =>
    timing.allDay ? `${value}T00:00:00` : graphLocal(value, timing.timeZone);
  const wallStart = local(timing.start);
  const wallEnd = local(timing.end);
  // Graph accepts a local datetime and a timezone. A repeated clock time
  // cannot carry the offset choice, so refuse it before posting.
  if (
    !timing.allDay &&
    (ambiguousGraphTime(timing.start, timing.timeZone, wallStart) ||
      ambiguousGraphTime(timing.end, timing.timeZone, wallEnd))
  )
    return { status: "unsupported" };
  const body = {
    subject: event.title,
    isAllDay: timing.allDay,
    start: { dateTime: wallStart, timeZone: timing.timeZone },
    end: { dateTime: wallEnd, timeZone: timing.timeZone },
    ...(event.notes && { body: { contentType: "text", content: event.notes } }),
    ...(event.location && { location: { displayName: event.location } }),
    recurrence: graphRecurrence(event, wallStart.slice(0, 10)),
    transactionId: writeKey,
  };
  const response = await proxy({ method: "POST", endpoint: `${target}/events`, body });
  if (!okay(response)) return failure(response.status, true);
  const saved = z.object({ id }).safeParse(response.data);
  return saved.success
    ? okayResult(operation.action, { id: saved.data.id, calendar })
    : { status: "uncertain" };
}
