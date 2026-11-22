import { expect, it } from "vitest";
import { formatRelativeTime } from "./relative-time";

it("formats relative time in the active language, falling back to English", () => {
  const now = new Date(2026, 5, 15, 12);
  expect(formatRelativeTime(new Date(2026, 5, 15, 11, 55).toISOString(), now)).toBe("5m ago");
  expect(formatRelativeTime(new Date(2025, 0, 15, 12).toISOString(), now)).toBe("Jan 15, 2025");
});
