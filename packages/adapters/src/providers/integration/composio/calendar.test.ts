import type { ConnectedCalendarOperation, ConnectedConnector } from "@rakazo/adapter-kit";
import { createAdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { connectedCalendarProvider, executeConnectedCalendar } from "./calendar.js";

const connection: ConnectedConnector = {
  id: "account-b",
  connectorId: "composio",
  externalId: "googlecalendar",
  displayName: "Work",
  providerRef: "account-b-ref",
};
const calendar = {
  source: "connected",
  calendarId: "my calendar",
  accountId: connection.id,
} as const;
const draft: ConnectedCalendarOperation = {
  action: "create_calendar_event",
  input: {
    calendar,
    event: {
      title: "Practice",
      timing: {
        allDay: false,
        start: "2026-10-16T08:00:00-04:00",
        end: "2026-10-16T09:00:00-04:00",
        timeZone: "America/New_York",
      },
      recurrence: { frequency: "weekly", interval: 2, count: 4 },
    },
  },
};

describe("connected calendar contract", () => {
  it("propagates unexpected provider errors and marks a write timeout as uncertain", async () => {
    const proxyExecute = vi.fn();
    const provider = connectedCalendarProvider(async () => ({ proxyExecute }));
    const context = createAdapterContext({ spaceId: "space", userId: "user" }, "bot", "operation");
    const read = { action: "list_calendars", input: { source: "connected" } } as const;
    const programmingError = new TypeError("Unexpected proxy failure");
    proxyExecute.mockRejectedValueOnce(programmingError);
    await expect(provider.calendar(connection, read, "read", context)).rejects.toBe(
      programmingError,
    );

    proxyExecute
      .mockResolvedValueOnce({
        status: 200,
        data: { id: calendar.calendarId, accessRole: "owner" },
      })
      .mockRejectedValueOnce(Object.assign(new Error("Timeout"), { status: 408, headers: {} }));
    await expect(provider.calendar(connection, draft, "write", context)).resolves.toEqual({
      status: "uncertain",
    });
  });

  it("expands occurrences and keeps their calendar, source dates, and original occurrence", async () => {
    const proxy = vi.fn(async () => ({
      status: 200,
      data: {
        timeZone: "America/New_York",
        nextPageToken: "next",
        items: [
          {
            id: "event-instance",
            summary: "Away",
            start: { date: "2026-10-16" },
            end: { date: "2026-10-17" },
            recurringEventId: "series",
            originalStartTime: { date: "2026-10-15" },
          },
        ],
      },
    }));
    const result = await executeConnectedCalendar(
      proxy,
      connection,
      {
        action: "list_calendar_events",
        input: { calendar, window: { from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" } },
      },
      "read",
    );
    expect(proxy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "https://www.googleapis.com/calendar/v3/calendars/my%20calendar/events",
        parameters: expect.arrayContaining([{ in: "query", name: "singleEvents", value: "true" }]),
      }),
    );
    expect(result).toEqual({
      status: "ok",
      data: {
        events: [
          {
            id: "event-instance",
            title: "Away",
            calendar,
            start: "2026-10-16",
            end: "2026-10-17",
            allDay: true,
            timeZone: "America/New_York",
            endTimeZone: "America/New_York",
            recurrence: { seriesId: "series", originalStart: "2026-10-15" },
          },
        ],
        truncated: true,
      },
    });
  });

  it("posts only to the explicitly writable calendar and reconciles the same event after a retry", async () => {
    const posted: Array<{ id: string }> = [];
    const proxy: Parameters<typeof executeConnectedCalendar>[0] = async ({
      method,
      endpoint,
      body,
    }) => {
      if (method === "POST") {
        const event = body as { id: string };
        posted.push(event);
        return { status: posted.length === 1 ? 201 : 409, data: event };
      }
      if (endpoint.includes("/calendarList/"))
        return { status: 200, data: { id: calendar.calendarId, accessRole: "writer" } };
      expect(endpoint).toMatch(new RegExp(`/calendars/my%20calendar/events/${posted[0]?.id}$`));
      return { status: 200, data: posted[0] };
    };
    const first = await executeConnectedCalendar(proxy, connection, draft, "same effect");
    const second = await executeConnectedCalendar(proxy, connection, draft, "same effect");
    expect(second).toEqual(first);
    expect(first).toMatchObject({ status: "ok", data: { calendar } });
    expect(posted).toHaveLength(2);
    expect(posted[0]).toEqual(posted[1]);
    expect(posted[0]).toMatchObject({
      start: { dateTime: "2026-10-16T08:00:00-04:00", timeZone: "America/New_York" },
      recurrence: ["RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4"],
    });
  });

  it("reads Outlook events in Windows time zones on their local day and time", async () => {
    const event = (id: string, zone: string, allDay: boolean, start: string, end: string) => ({
      id,
      subject: id,
      isAllDay: allDay,
      start: { dateTime: start, timeZone: "UTC" },
      end: { dateTime: end, timeZone: "UTC" },
      originalStartTimeZone: zone,
      originalEndTimeZone: zone,
    });
    const proxy = vi.fn(async () => ({
      status: 200,
      data: {
        value: [
          event(
            "tokyo",
            "Tokyo Standard Time",
            true,
            "2026-11-19T15:00:00.0000000",
            "2026-11-20T15:00:00.0000000",
          ),
          event(
            "pacific",
            "Pacific Standard Time",
            true,
            "2026-11-20T08:00:00.0000000",
            "2026-11-21T08:00:00.0000000",
          ),
          event(
            "iana",
            "Asia/Tokyo",
            true,
            "2026-11-19T15:00:00.0000000",
            "2026-11-20T15:00:00.0000000",
          ),
          event(
            "unknown",
            "Custom Zone",
            true,
            "2026-11-19T15:00:00.0000000",
            "2026-11-20T15:00:00.0000000",
          ),
          event(
            "timed",
            "Pacific Standard Time",
            false,
            "2026-11-20T17:00:00.0000000",
            "2026-11-20T18:00:00.0000000",
          ),
        ],
      },
    }));
    const result = await executeConnectedCalendar(
      proxy,
      { ...connection, externalId: "outlook" },
      {
        action: "list_calendar_events",
        input: { calendar, window: { from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z" } },
      },
      "read",
    );
    expect(result).toEqual({
      status: "ok",
      data: {
        truncated: false,
        events: [
          expect.objectContaining({
            id: "tokyo",
            start: "2026-11-20",
            end: "2026-11-21",
            timeZone: "Asia/Tokyo",
          }),
          expect.objectContaining({
            id: "pacific",
            start: "2026-11-20",
            end: "2026-11-21",
            timeZone: "America/Los_Angeles",
          }),
          expect.objectContaining({
            id: "iana",
            start: "2026-11-20",
            end: "2026-11-21",
            timeZone: "Asia/Tokyo",
          }),
          expect.objectContaining({
            id: "unknown",
            start: "2026-11-19T15:00:00.000Z",
            end: "2026-11-20T15:00:00.000Z",
            timeZone: "Custom Zone",
          }),
          expect.objectContaining({
            id: "timed",
            start: "2026-11-20T17:00:00.000Z",
            end: "2026-11-20T18:00:00.000Z",
            timeZone: "America/Los_Angeles",
          }),
        ],
      },
    });
  });

  it("never posts for a read-only calendar or an account-relative calendar alias", async () => {
    const proxy = vi.fn(async () => ({
      status: 200,
      data: { id: calendar.calendarId, accessRole: "reader" },
    }));
    await expect(executeConnectedCalendar(proxy, connection, draft, "write")).resolves.toEqual({
      status: "denied",
    });
    expect(proxy).toHaveBeenCalledTimes(1);
    await expect(
      executeConnectedCalendar(
        proxy,
        connection,
        {
          ...draft,
          input: { ...draft.input, calendar: { ...calendar, calendarId: "primary" } },
        },
        "write",
      ),
    ).resolves.toEqual({ status: "unavailable" });
    expect(proxy).toHaveBeenCalledTimes(1);
  });

  it("pins Outlook writes to the selected calendar, local timezone and a stable transaction id", async () => {
    const proxy = vi
      .fn<Parameters<typeof executeConnectedCalendar>[0]>()
      .mockResolvedValueOnce({
        status: 200,
        data: { id: calendar.calendarId, name: "Work", canEdit: true },
      })
      .mockResolvedValueOnce({ status: 201, data: { id: "saved-event" } });
    await expect(
      executeConnectedCalendar(
        proxy,
        { ...connection, externalId: "outlook" },
        draft,
        "same effect",
      ),
    ).resolves.toEqual({ status: "ok", data: { id: "saved-event", calendar } });
    expect(proxy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        endpoint: "https://graph.microsoft.com/v1.0/me/calendars/my%20calendar/events",
        method: "POST",
        body: expect.objectContaining({
          transactionId: expect.stringMatching(/^[a-f\d]{64}$/u),
          start: { dateTime: "2026-10-16T08:00:00.000", timeZone: "America/New_York" },
          recurrence: {
            pattern: {
              type: "weekly",
              interval: 2,
              daysOfWeek: ["friday"],
              firstDayOfWeek: "friday",
            },
            range: {
              type: "numbered",
              startDate: "2026-10-16",
              numberOfOccurrences: 4,
              recurrenceTimeZone: "America/New_York",
            },
          },
        }),
      }),
    );
  });
});
