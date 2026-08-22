import { describe, expect, it } from "vitest";
import {
  formatChatTimestamp,
  formatClock,
  formatInboxTime,
  shouldShowChatTimestamp,
} from "./chat-time.js";

const now = new Date(2026, 7, 21, 18, 14, 0);

describe("formatClock", () => {
  it("uses a 12-hour clock", () => {
    expect(formatClock(new Date(2026, 7, 21, 18, 14, 0))).toBe("6:14 PM");
    expect(formatClock(new Date(2026, 7, 21, 0, 5, 0))).toBe("12:05 AM");
    expect(formatClock(new Date(2026, 7, 21, 12, 0, 0))).toBe("12:00 PM");
  });
});

describe("formatChatTimestamp", () => {
  it("labels today, yesterday, this week, and older days", () => {
    expect(formatChatTimestamp(local(now, 0, 18, 14), now)).toBe("Today 6:14 PM");
    expect(formatChatTimestamp(local(now, 1, 9, 3), now)).toBe("Yesterday 9:03 AM");
    expect(formatChatTimestamp(local(now, 2, 10, 0), now)).toBe("Wednesday 10:00 AM");
    expect(formatChatTimestamp(local(now, 20, 9, 0), now)).toBe("Aug 1, 9:00 AM");
  });

  it("returns nothing for an invalid timestamp", () => {
    expect(formatChatTimestamp("not-a-date", now)).toBe("");
  });

  it("does not label future calendar days as today", () => {
    expect(formatChatTimestamp(local(now, -1, 9, 0), now)).toBe("Aug 22, 9:00 AM");
  });

  it("uses calendar days across daylight-saving transitions", () => {
    const afterSpringTransition = new Date(2026, 2, 9, 12, 0, 0);
    const previousDay = new Date(afterSpringTransition);
    previousDay.setDate(previousDay.getDate() - 1);
    expect(formatChatTimestamp(previousDay.toISOString(), afterSpringTransition)).toContain(
      "Yesterday",
    );
  });
});

describe("formatInboxTime", () => {
  it("shows a clock for today and a date otherwise", () => {
    expect(formatInboxTime(local(now, 0, 14, 44), now)).toBe("2:44 PM");
    expect(formatInboxTime(local(now, 1, 10, 0), now)).toBe("Yesterday");
    expect(formatInboxTime(local(now, 2, 10, 0), now)).toBe("Wednesday");
    expect(formatInboxTime(local(now, 20, 9, 0), now)).toBe("Aug 1");
    expect(formatInboxTime(local(now, -1, 9, 0), now)).toBe("Aug 22");
  });
});

describe("shouldShowChatTimestamp", () => {
  it("shows the first stamp and later gaps of ten minutes or a new day", () => {
    const first = local(now, 0, 18, 0);
    const soon = local(now, 0, 18, 4);
    const later = local(now, 0, 18, 14);
    const nextDay = local(now, 0, 0, 1);
    expect(shouldShowChatTimestamp(undefined, first)).toBe(true);
    expect(shouldShowChatTimestamp(first, soon)).toBe(false);
    expect(shouldShowChatTimestamp(first, later)).toBe(true);
    expect(shouldShowChatTimestamp(local(now, 1, 23, 59), nextDay)).toBe(true);
    expect(shouldShowChatTimestamp(first, "nope")).toBe(false);
  });
});

function local(base: Date, daysAgo: number, hours: number, minutes: number) {
  const date = new Date(base);
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
}
