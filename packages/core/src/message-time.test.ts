import { describe, expect, it } from "vitest";
import { formatMessageTime } from "./message-time.js";

const now = new Date(2026, 9, 4, 15, 30);

describe("message time label", () => {
  it("shows only the time for messages from today", () => {
    expect(formatMessageTime(new Date(2026, 9, 4, 0, 5), "en-US", now)).toBe("12:05 AM");
  });

  it("adds the month and day for earlier days", () => {
    expect(formatMessageTime(new Date(2026, 9, 3, 23, 59), "en-US", now)).toBe("Oct 3, 11:59 PM");
    expect(formatMessageTime(new Date(2026, 8, 13, 9, 14), "en-US", now)).toBe("Sep 13, 9:14 AM");
  });

  it("adds the year for messages from another year", () => {
    expect(formatMessageTime(new Date(2025, 11, 31, 8, 0), "en-US", now)).toBe(
      "Dec 31, 2025, 8:00 AM",
    );
  });

  it("returns an empty label for an invalid timestamp", () => {
    expect(formatMessageTime("not a date", "en-US", now)).toBe("");
  });
});
