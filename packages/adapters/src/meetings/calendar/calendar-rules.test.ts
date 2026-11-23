import { expect, it } from "vitest";
import { matchCalendarRule, meetingBookingKey } from "./calendar-rules.js";

it("uses an explicit skip or event selection before the recurring preference", () => {
  const rule = { targetId: "series-a", scope: "series", botId: "bot-a" };
  expect(matchCalendarRule([rule], { id: "event-a", seriesId: "series-a" })).toEqual(rule);

  const skip = { targetId: "event-b", scope: "event", botId: null };
  expect(matchCalendarRule([rule, skip], { id: "event-b", seriesId: "series-a" })).toEqual(skip);
  expect(matchCalendarRule([rule, skip], { id: "event-c", seriesId: "series-a" })).toEqual(rule);
});

it("deduplicates copies of an occurrence while isolating spaces, bots, and repeats", () => {
  const time = new Date("2026-11-18T10:00:00Z");
  const key = meetingBookingKey("space-a", "bot-a", "conference-a", time);
  expect(meetingBookingKey("space-a", "bot-a", "conference-a", new Date(time))).toBe(key);
  expect(meetingBookingKey("space-b", "bot-a", "conference-a", time)).not.toBe(key);
  expect(meetingBookingKey("space-a", "bot-b", "conference-a", time)).not.toBe(key);
  expect(
    meetingBookingKey("space-a", "bot-a", "conference-a", new Date("2026-11-25T10:00:00Z")),
  ).not.toBe(key);
});
