import { describe, expect, it } from "vitest";
import { formatTimeSeparator, needsTimeSeparator, timeSeparatorIds } from "./time-separators.js";

const at = (day: number, hour = 0, minute = 0) => new Date(2026, 9, day, hour, minute);

describe("time separators in the viewer's local calendar", () => {
  it("marks the first message and the exact 15-minute threshold", () => {
    expect(needsTimeSeparator(at(8, 14))).toBe(true);
    expect(needsTimeSeparator(at(8, 14, 14), at(8, 14))).toBe(false);
    expect(needsTimeSeparator(at(8, 14, 15), at(8, 14))).toBe(true);
    expect(needsTimeSeparator(at(8, 14, 16), at(8, 14))).toBe(true);
  });
  it("marks midnight even with only a minute between messages", () => {
    expect(needsTimeSeparator(at(8), at(7, 23, 59))).toBe(true);
    expect(formatTimeSeparator(at(7, 23, 59), "en-US", at(8, 0, 1))).toBe("Yesterday 11:59 PM");
  });
  it("formats today, weekdays, older dates, and a different year", () => {
    expect(formatTimeSeparator(at(8, 14, 20), "en-US", at(8, 15))).toBe("Today 2:20 PM");
    expect(formatTimeSeparator(at(6, 16, 5), "en-US", at(8))).toBe("Tuesday 4:05 PM");
    expect(formatTimeSeparator(at(1, 16, 5), "en-US", at(8))).toBe("Oct 1, 4:05 PM");
    expect(formatTimeSeparator(new Date(2025, 11, 31, 16, 5), "en-US", at(8))).toBe(
      "Dec 31, 2025, 4:05 PM",
    );
    expect(formatTimeSeparator(new Date(2025, 11, 31, 23, 59), "en-US", new Date(2026, 0, 1))).toBe(
      "Yesterday 11:59 PM",
    );
  });
  it("uses the app locale's labels and hour cycle", () => {
    expect(formatTimeSeparator(at(8, 14, 20), "de", at(8, 15))).toBe("Heute 14:20");
    expect(formatTimeSeparator(at(7, 14, 20), "de", at(8))).toBe("Gestern 14:20");
  });
  it("groups consecutive messages without marking every row", () => {
    const messages = [at(8, 12), at(8, 12, 1), at(8, 12, 16), at(9)].map((date, id) => ({
      id: String(id),
      createdAt: date.toISOString(),
    }));
    expect([...timeSeparatorIds(messages)]).toEqual(["0", "2", "3"]);
    expect(needsTimeSeparator("invalid")).toBe(false);
    expect(formatTimeSeparator("invalid", "en-US")).toBe("");
  });
});
