import { describe, expect, it } from "vitest";
import { expandCalendarObject } from "./ical-events.js";

const window = {
  from: new Date("2026-11-18T00:00:00Z"),
  through: new Date("2026-12-02T00:00:00Z"),
};
const isMeeting = (candidate: string) =>
  /^https:\/\/(?:[\w-]+\.)?(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com)\//u.test(candidate);

const brussels = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Brussels",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "DTSTART:19810329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "TZNAME:CEST",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "DTSTART:19961027T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "TZNAME:CET",
  "END:STANDARD",
  "END:VTIMEZONE",
];

function calendar(...lines: string[]) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", ...lines, "END:VCALENDAR"].join(
    "\r\n",
  );
}

describe("expandCalendarObject", () => {
  it("reads a one-off meeting with its link in the location and its time zone", () => {
    const text = calendar(
      ...brussels,
      "BEGIN:VEVENT",
      "UID:one-off@example.test",
      "DTSTAMP:20261101T000000Z",
      "DTSTART;TZID=Europe/Brussels:20261120T100000",
      "DTEND;TZID=Europe/Brussels:20261120T110000",
      "SUMMARY:Design review",
      "LOCATION:https://example.zoom.us/j/123456789?pwd=abc.",
      "END:VEVENT",
    );
    expect(expandCalendarObject(text, window, isMeeting)).toEqual([
      {
        uid: "one-off@example.test",
        recurrenceId: null,
        recurring: false,
        title: "Design review",
        startsAt: new Date("2026-11-20T09:00:00Z"),
        endsAt: new Date("2026-11-20T10:00:00Z"),
        meetingUrl: "https://example.zoom.us/j/123456789?pwd=abc",
        cancelled: false,
        declined: false,
      },
    ]);
  });

  it("finds the link in the description when the location is a room", () => {
    const text = calendar(
      "BEGIN:VEVENT",
      "UID:room@example.test",
      "DTSTAMP:20261101T000000Z",
      "DTSTART:20261121T150000Z",
      "DTEND:20261121T153000Z",
      "LOCATION:Room 4",
      "DESCRIPTION:Agenda first.\\nJoin: <https://meet.google.com/abc-defg-hij>\\nThanks",
      "END:VEVENT",
    );
    expect(expandCalendarObject(text, window, isMeeting)[0]?.meetingUrl).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
  });

  it("expands a weekly series with an exception, a moved occurrence and a cancelled one", () => {
    const text = calendar(
      ...brussels,
      "BEGIN:VEVENT",
      "UID:weekly@example.test",
      "DTSTAMP:20261101T000000Z",
      "DTSTART;TZID=Europe/Brussels:20250106T093000",
      "DTEND;TZID=Europe/Brussels:20250106T100000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "EXDATE;TZID=Europe/Brussels:20261123T093000",
      "SUMMARY:Standup",
      "URL:https://meet.google.com/abc-defg-hij",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:weekly@example.test",
      "DTSTAMP:20261101T000000Z",
      "RECURRENCE-ID;TZID=Europe/Brussels:20261130T093000",
      "DTSTART;TZID=Europe/Brussels:20261201T140000",
      "DTEND;TZID=Europe/Brussels:20261201T143000",
      "SUMMARY:Standup (moved)",
      "URL:https://meet.google.com/abc-defg-hij",
      "END:VEVENT",
    );
    const occurrences = expandCalendarObject(text, window, isMeeting);
    expect(
      occurrences.map(({ title, startsAt, recurrenceId, recurring }) => ({
        title,
        startsAt: startsAt.toISOString(),
        recurrenceId,
        recurring,
      })),
    ).toEqual([
      {
        title: "Standup (moved)",
        startsAt: "2026-12-01T13:00:00.000Z",
        recurrenceId: "2026-11-30T08:30:00.000Z",
        recurring: true,
      },
    ]);
  });

  it("marks cancelled and declined occurrences", () => {
    const text = calendar(
      "BEGIN:VEVENT",
      "UID:declined@example.test",
      "DTSTAMP:20261101T000000Z",
      "DTSTART:20261125T150000Z",
      "DTEND:20261125T160000Z",
      "URL:https://example.zoom.us/j/123456789",
      "ATTENDEE;PARTSTAT=DECLINED;CN=Me:mailto:Me@Example.test",
      "ATTENDEE;PARTSTAT=ACCEPTED:mailto:someone@example.test",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:cancelled@example.test",
      "DTSTAMP:20261101T000000Z",
      "DTSTART:20261126T150000Z",
      "DTEND:20261126T160000Z",
      "STATUS:CANCELLED",
      "URL:https://example.zoom.us/j/123456789",
      "END:VEVENT",
    );
    const [declined, cancelled] = expandCalendarObject(text, window, isMeeting, [
      "me@example.test",
    ]);
    expect(declined).toMatchObject({ declined: true, cancelled: false });
    expect(cancelled).toMatchObject({ declined: false, cancelled: true });
  });

  it("skips all-day entries, events without a link stay listed without one, and bad data", () => {
    const text = calendar(
      "BEGIN:VEVENT",
      "UID:holiday@example.test",
      "DTSTAMP:20261101T000000Z",
      "DTSTART;VALUE=DATE:20261124",
      "DTEND;VALUE=DATE:20261125",
      "URL:https://example.zoom.us/j/123456789",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:lunch@example.test",
      "DTSTAMP:20261101T000000Z",
      "DTSTART:20261124T120000Z",
      "DTEND:20261124T130000Z",
      "LOCATION:https://example.test/not-a-meeting",
      "END:VEVENT",
    );
    expect(expandCalendarObject(text, window, isMeeting)).toMatchObject([
      { uid: "lunch@example.test", meetingUrl: null },
    ]);
    expect(expandCalendarObject("BEGIN:VCALENDAR\r\nnot ical", window, isMeeting)).toEqual([]);
  });

  it("keeps an occurrence invited without its series", () => {
    const text = calendar(
      "BEGIN:VEVENT",
      "UID:series@example.test",
      "DTSTAMP:20261101T000000Z",
      "RECURRENCE-ID:20261127T090000Z",
      "DTSTART:20261127T090000Z",
      "DTEND:20261127T093000Z",
      "URL:https://teams.microsoft.com/l/meetup-join/abc",
      "END:VEVENT",
    );
    expect(expandCalendarObject(text, window, isMeeting)).toMatchObject([
      { recurring: true, recurrenceId: "2026-11-27T09:00:00.000Z" },
    ]);
  });
});

describe("time zones without VTIMEZONE", () => {
  it("reads an IANA TZID with the runtime's zone data", () => {
    const text = calendar(
      "BEGIN:VEVENT",
      "UID:ny@example.test",
      "DTSTAMP:20261101T000000Z",
      "DTSTART;TZID=America/New_York:20261120T100000",
      "DTEND;TZID=America/New_York:20261120T110000",
      "URL:https://example.zoom.us/j/123456789",
      "END:VEVENT",
    );
    expect(expandCalendarObject(text, window, isMeeting)[0]).toMatchObject({
      startsAt: new Date("2026-11-20T15:00:00Z"),
      endsAt: new Date("2026-11-20T16:00:00Z"),
    });
  });
});
