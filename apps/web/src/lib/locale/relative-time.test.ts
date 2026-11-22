import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./relative-time";

describe("formatRelativeTime", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");

  it.each([
    { seconds: 0, label: "just now" },
    { seconds: 44, label: "just now" },
    { seconds: 45, label: "just now" },
    { seconds: 59, label: "just now" },
    { seconds: 59.999, label: "just now" },
    { seconds: 60, label: "1m ago" },
    { seconds: 3_599, label: "59m ago" },
    { seconds: 3_600, label: "1h ago" },
    { seconds: 86_400, label: "1d ago" },
  ])("formats $seconds seconds ago as $label", ({ seconds, label }) => {
    const iso = new Date(now.getTime() - seconds * 1_000).toISOString();
    expect(formatRelativeTime(iso, now)).toBe(label);
  });

  it("distinguishes the same date in different years", () => {
    const now = new Date(2026, 5, 15, 12);
    expect(formatRelativeTime(new Date(2024, 0, 15, 12).toISOString(), now)).toBe("Jan 15, 2024");
    expect(formatRelativeTime(new Date(2025, 0, 15, 12).toISOString(), now)).toBe("Jan 15, 2025");
    expect(formatRelativeTime(new Date(2026, 0, 15, 12).toISOString(), now)).toBe("Jan 15");
  });

  it("switches from relative time to the local calendar date at seven days", () => {
    const date = new Date(2025, 11, 31, 23, 30);
    const cutoff = date.getTime() + 7 * 86_400_000;
    expect(formatRelativeTime(date.toISOString(), new Date(cutoff - 1))).toBe("6d ago");
    expect(formatRelativeTime(date.toISOString(), new Date(cutoff))).toBe("Dec 31, 2025");
  });
});
