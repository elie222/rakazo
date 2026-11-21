import type { MeetingCalendarEvent } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { RecallCalendarEmulator } from "./calendar-emulator.js";

const now = new Date("2026-11-18T10:00:00Z");
const signal = new AbortController().signal;

async function connect(emulator: RecallCalendarEmulator, connectionId: string) {
  const redirectUri = "https://rakazo.example.test/api/meetings/calendar/oauth/callback";
  const { provider } = emulator;
  const authorizationUrl = new URL(
    provider.authorizationUrl({
      state: "calendar-state",
      challenge: "calendar-challenge",
      redirectUri,
    }),
  );
  expect(authorizationUrl.searchParams.get("state")).toBe("calendar-state");
  const code = authorizationUrl.searchParams.get("code");
  if (!code) throw new Error("Emulator did not return an OAuth code.");
  return (
    await provider.connect(
      { connectionRef: connectionId, code, redirectUri, verifier: "calendar-verifier" },
      signal,
    )
  ).calendarId;
}

async function eventsFor(emulator: RecallCalendarEmulator, id: string) {
  const events = [];
  for await (const event of emulator.provider.listEvents(id, { upcoming: now }, signal)) {
    events.push(event);
  }
  return events;
}

function schedule(emulator: RecallCalendarEmulator, event: MeetingCalendarEvent, key: string) {
  if (!event.meetingUrl) throw new Error("Expected meeting link in fixture");
  const platform =
    new URL(event.meetingUrl).hostname === "meet.google.com" ? "google_meet" : "zoom";
  return emulator.provider.schedule(
    event.id,
    key,
    event.startsAt,
    {
      sessionId: "fixture-session",
      botName: "Atlas · Rakazo",
      meetingUrl: event.meetingUrl,
      platform,
      expiresAt: event.endsAt,
    },
    signal,
  );
}

describe("calendar provider over its offline HTTP protocol", () => {
  it("links an OAuth calendar, pages across occurrences, and normalizes decline and cancellation", async () => {
    const emulator = new RecallCalendarEmulator(now);
    const calendarId = await connect(emulator, "calendar-one");
    expect((await emulator.provider.getConnection(calendarId, signal))?.status).toBe("connected");

    const events = await eventsFor(emulator, calendarId);
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.seriesId)).toEqual(["design-review", null, "design-review"]);

    emulator.revision(events[0]!.id, {
      raw: { summary: "Design review", attendees: [{ self: true, responseStatus: "declined" }] },
    });
    expect(await emulator.provider.getEvent(events[0]!.id, signal)).toMatchObject({
      declined: true,
    });
    emulator.revision(events[1]!.id, { is_deleted: true });
    expect(await emulator.provider.getEvent(events[1]!.id, signal)).toMatchObject({
      cancelled: true,
    });
    expect(await eventsFor(emulator, calendarId)).toHaveLength(2);

    await emulator.provider.disconnect(calendarId, signal);
    expect(await emulator.provider.getConnection(calendarId, signal)).toBeNull();
  });

  it("deduplicates a shared occurrence and preserves the other calendar on unschedule", async () => {
    const emulator = new RecallCalendarEmulator(now);
    const first = (await eventsFor(emulator, await connect(emulator, "calendar-one")))[0]!;
    const second = (await eventsFor(emulator, await connect(emulator, "calendar-two")))[0]!;
    const id = await schedule(emulator, first, "shared-occurrence");
    await expect(schedule(emulator, second, "shared-occurrence")).resolves.toBe(id);

    await emulator.provider.unschedule(first.id, signal);
    expect(emulator.scheduled(first.id)).toBeUndefined();
    expect(emulator.scheduled(second.id)).toBe(id);
  });

  it("returns capacity retry hints and validates signed change notifications", async () => {
    const emulator = new RecallCalendarEmulator(now);
    const calendarId = await connect(emulator, "calendar-one");
    const event = (await eventsFor(emulator, calendarId))[0]!;
    emulator.denyNextSchedule(507);
    await expect(schedule(emulator, event, "occurrence")).rejects.toMatchObject({
      delayMs: 30_000,
    });
    expect(emulator.scheduled(event.id)).toBeUndefined();
    expect(await schedule(emulator, event, "occurrence")).toBeTruthy();

    const { body, headers } = emulator.change(calendarId);
    expect(emulator.provider.verifyChange(body, headers)).toMatchObject({
      kind: "events",
      calendarId,
    });
    expect(emulator.provider.verifyChange(body, new Headers())).toBeNull();
    expect(
      emulator.provider.verifyChange(body.replace(calendarId, "different"), headers),
    ).toBeNull();
  });
});

describe("Recall calendar title emoji limit", () => {
  it("does not cut an emoji in half in an event title", async () => {
    const emulator = new RecallCalendarEmulator(now);
    const calendarId = await connect(emulator, "calendar-one");
    const [event] = await eventsFor(emulator, calendarId);
    emulator.revision(event!.id, { raw: { summary: `${"a".repeat(299)}😀 tail` } });
    expect(await emulator.provider.getEvent(event!.id, signal)).toMatchObject({
      title: "a".repeat(299),
    });
  });
});
