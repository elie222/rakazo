import { describe, expect, it } from "vitest";
import { latestEndedDate, stampMemoryEntry } from "./memory-expiry.js";

describe("stampMemoryEntry", () => {
  it("keeps an end that only starts with a date as an event", () => {
    expect(
      stampMemoryEntry("Hold sends.", "2026-03-05", "2026-03-20 after the board meeting"),
    ).toBe("Hold sends. (saved 2026-03-05, ends when 2026-03-20 after the board meeting)");
  });

  it("does not take an impossible date as an end date", () => {
    expect(stampMemoryEntry("Hold sends.", "2026-03-05", "2026-02-30")).toBe(
      "Hold sends. (saved 2026-03-05, ends when 2026-02-30)",
    );
  });

  it("writes an entry that ends on one line", () => {
    expect(stampMemoryEntry("Hold sends:\nall newsletters", "2026-03-05", "2026-03-20")).toBe(
      "Hold sends: all newsletters (saved 2026-03-05, ends 2026-03-20)",
    );
  });
});

it("ends a date only once it is over in every time zone", () => {
  expect(latestEndedDate(new Date("2026-03-20T11:30:00Z"))).toBe("2026-03-19");
  expect(latestEndedDate(new Date("2026-03-20T12:30:00Z"))).toBe("2026-03-20");
});
