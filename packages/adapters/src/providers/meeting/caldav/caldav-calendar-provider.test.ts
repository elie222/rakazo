import { randomUUID } from "node:crypto";
import type { MeetingCalendarEvent, MeetingJoinRequest } from "@rakazo/adapter-kit";
import { MeetingCalendarConnectRejected } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { ScheduledMeetingBots } from "./caldav-calendar-provider.js";
import { CalDavCalendarProvider } from "./caldav-calendar-provider.js";

const signal = new AbortController().signal;
const now = new Date("2026-11-18T10:00:00Z");
const origin = "https://caldav.example.test";
const home = `${origin}/123/calendars/`;
const work = `${home}work/`;
const reminders = `${home}tasks/`;
const personal = `${home}personal/`;
const standupUrl = `${work}standup.ics`;
const reviewUrl = `${work}review.ics`;

function ics(...lines: string[]) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR"].join("\r\n");
}

const objects = new Map<string, string>([
  [
    standupUrl,
    ics(
      "BEGIN:VEVENT",
      "UID:standup",
      "DTSTAMP:20261101T000000Z",
      "DTSTART:20261116T090000Z",
      "DTEND:20261116T091500Z",
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "SUMMARY:Standup & planning",
      "URL:https://meet.google.com/abc-defg-hij",
      "END:VEVENT",
    ),
  ],
  [
    reviewUrl,
    ics(
      "BEGIN:VEVENT",
      "UID:review",
      "DTSTAMP:20261101T000000Z",
      "DTSTART:20261119T150000Z",
      "DTEND:20261119T160000Z",
      "SUMMARY:Review",
      "LOCATION:https://example.zoom.us/j/123456789",
      "END:VEVENT",
    ),
  ],
]);

/** Escapes like many servers do, including the CR of each line ending. */
function escapeXml(value: string) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/\r/gu, "&#13;");
}

function multistatus(...responses: string[]) {
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${responses.join("")}</d:multistatus>`;
}

function response(href: string, props: string) {
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

function fakeServer(password = "app-password") {
  const requests: { method: string; url: string }[] = [];
  const fetch = vi.fn(async (url: URL, init: RequestInit) => {
    const method = init.method ?? "GET";
    requests.push({ method, url: url.href });
    const expected = `Basic ${Buffer.from(`me@example.test:${password}`).toString("base64")}`;
    if (new Headers(init.headers).get("authorization") !== expected) {
      return new Response("", { status: 401 });
    }
    const body = String(init.body ?? "");
    if (
      method === "PROPFIND" &&
      url.href === `${origin}/` &&
      body.includes("current-user-principal")
    ) {
      return new Response(
        multistatus(
          response(
            "/",
            "<d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal>",
          ),
        ),
        { status: 207 },
      );
    }
    if (method === "PROPFIND" && url.href === `${origin}/123/principal/`) {
      return new Response(
        multistatus(
          response(
            "/123/principal/",
            "<c:calendar-home-set><d:href>/123/calendars/</d:href></c:calendar-home-set>",
          ),
        ),
        { status: 207 },
      );
    }
    if (method === "PROPFIND" && url.href === home) {
      return new Response(
        multistatus(
          response("/123/calendars/", "<d:resourcetype><d:collection/></d:resourcetype>"),
          response(
            "/123/calendars/work/",
            // iCloud style: default namespaces and the components the calendar holds.
            '<resourcetype xmlns="DAV:"><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype><displayname xmlns="DAV:">Work</displayname><supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav"><comp name="VEVENT"/><comp name="VTODO"/></supported-calendar-component-set>',
          ),
          response(
            "/123/calendars/personal/",
            "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>",
          ),
          response(
            "/123/calendars/tasks/",
            '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>',
          ),
        ),
        { status: 207 },
      );
    }
    if (method === "REPORT" && url.href === personal) {
      // A calendar with nothing in range answers with an empty multistatus.
      return new Response('<?xml version="1.0"?>\n<multistatus xmlns="DAV:"/>', { status: 207 });
    }
    if (method === "REPORT" && url.href === work) {
      expect(body).toContain('start="20261118T100000Z"');
      return new Response(
        multistatus(
          ...[...objects].map(([href, data]) =>
            response(
              new URL(href).pathname,
              `<c:calendar-data>${escapeXml(data)}</c:calendar-data>`,
            ),
          ),
        ),
        { status: 207 },
      );
    }
    if (method === "GET") {
      const data = objects.get(url.href);
      return data ? new Response(data) : new Response("", { status: 404 });
    }
    return new Response("", { status: 400 });
  });
  return { fetch, requests };
}

function setup(password?: string) {
  const server = fakeServer(password);
  const sealed = new Map<string, string>();
  const bots: ScheduledMeetingBots = {
    schedule: vi.fn(async () => "bot-1"),
    cancel: vi.fn(async () => {}),
  };
  const provider = new CalDavCalendarProvider({
    accounts: { load: async (calendarId) => sealed.get(calendarId) ?? null },
    bots,
    fetch: server.fetch,
    now: () => now,
  });
  return { provider, sealed, bots, ...server };
}

async function connected() {
  const context = setup();
  const calendarId = randomUUID();
  context.sealed.set(
    calendarId,
    await context.provider.verifyAccount(
      { serverUrl: ` ${origin} `, username: "me@example.test", password: "app-password" },
      signal,
    ),
  );
  return { ...context, calendarId };
}

async function list(provider: CalDavCalendarProvider, calendarId: string) {
  const events: MeetingCalendarEvent[] = [];
  for await (const event of provider.listEvents(
    calendarId,
    { upcoming: now, startsThrough: new Date("2026-11-30T00:00:00Z") },
    signal,
  )) {
    events.push(event);
  }
  return events.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

describe("CalDavCalendarProvider", () => {
  it("finds the calendar home at sign-in and seals it with the account", async () => {
    const { sealed, calendarId } = await connected();
    expect(JSON.parse(sealed.get(calendarId)!)).toEqual({
      serverUrl: `${origin}/`,
      username: "me@example.test",
      password: "app-password",
      homeUrl: home,
    });
  });

  it("rejects refused credentials and non-HTTPS servers before storing anything", async () => {
    const { provider } = setup("other-password");
    await expect(
      provider.verifyAccount(
        { serverUrl: origin, username: "me@example.test", password: "app-password" },
        signal,
      ),
    ).rejects.toThrow(MeetingCalendarConnectRejected);
    await expect(
      provider.verifyAccount(
        { serverUrl: "http://caldav.example.test", username: "me", password: "x" },
        signal,
      ),
    ).rejects.toThrow(MeetingCalendarConnectRejected);
  });

  it("lists meetings from event calendars only, with recurring series", async () => {
    const { provider, calendarId, requests } = await connected();
    const events = await list(provider, calendarId);
    expect(
      events.map(({ title, startsAt, seriesId, meetingUrl }) => ({
        title,
        startsAt: startsAt.toISOString(),
        recurring: seriesId !== null,
        meetingUrl,
      })),
    ).toEqual([
      {
        title: "Review",
        startsAt: "2026-11-19T15:00:00.000Z",
        recurring: false,
        meetingUrl: "https://example.zoom.us/j/123456789",
      },
      {
        title: "Standup & planning",
        startsAt: "2026-11-23T09:00:00.000Z",
        recurring: true,
        meetingUrl: "https://meet.google.com/abc-defg-hij",
      },
    ]);
    expect(events[1]?.seriesId).toMatch(/^[\w-]{43}$/u);
    expect(requests.some(({ url }) => url === reminders)).toBe(false);
    for (const event of events) {
      expect(event.id.length).toBeLessThanOrEqual(256);
      expect(provider.eventCalendarId(event.id)).toBe(calendarId);
      expect(await provider.getEvent(event.id, signal)).toEqual(event);
    }
  });

  it("does not fetch an event address outside the account's calendars", async () => {
    const { provider, calendarId, requests } = await connected();
    const forged = `${calendarId}.o.${Buffer.from(
      JSON.stringify(["https://attacker.example.test/steal.ics", null]),
    ).toString("base64url")}`;
    expect(await provider.getEvent(forged, signal)).toBeNull();
    expect(requests.some(({ url }) => url.includes("attacker"))).toBe(false);
    expect(provider.eventCalendarId("not-an-event")).toBeNull();
  });

  it("reports a revoked app password as a disconnected calendar", async () => {
    const { provider, calendarId, sealed } = await connected();
    expect(await provider.getConnection(calendarId, signal)).toEqual({
      calendarId,
      status: "connected",
    });
    const account = JSON.parse(sealed.get(calendarId)!);
    sealed.set(calendarId, JSON.stringify({ ...account, password: "revoked" }));
    expect(await provider.getConnection(calendarId, signal)).toEqual({
      calendarId,
      status: "disconnected",
    });
    expect(await provider.getConnection(randomUUID(), signal)).toBeNull();
  });

  it("reserves one participant per session and releases it with the last booking", async () => {
    const { provider, bots } = setup();
    const request: MeetingJoinRequest = {
      sessionId: "session-1",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      platform: "google_meet",
      botName: "Atlas · Rakazo",
      expiresAt: new Date("2026-11-23T11:00:00Z"),
    };
    const startsAt = new Date("2026-11-23T09:00:00Z");
    expect(await provider.schedule("event", "key", startsAt, request, signal)).toBe("bot-1");
    expect(bots.schedule).toHaveBeenCalledWith(request, startsAt, signal);

    await provider.unschedule("event", signal, {
      sessionId: "session-1",
      externalId: "bot-1",
      lastBooking: false,
    });
    await provider.unschedule("event", signal);
    expect(bots.cancel).not.toHaveBeenCalled();
    await provider.unschedule("event", signal, {
      sessionId: "session-1",
      externalId: "bot-1",
      lastBooking: true,
    });
    expect(bots.cancel).toHaveBeenCalledWith("session-1", "bot-1", signal);
  });

  it("accepts no change notifications and has no OAuth sign-in", () => {
    const { provider } = setup();
    expect(provider.verifyChange()).toBeNull();
    expect(() => provider.authorizationUrl()).toThrow();
  });
});
