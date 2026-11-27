import { i18n } from "@lingui/core";
import { afterEach, expect, it, vi } from "vitest";
import { formatRelativeTime } from "./relative-time";

afterEach(() => vi.restoreAllMocks());

it("falls back to English when there is no active locale", () => {
  vi.spyOn(i18n, "locale", "get").mockReturnValue("");
  const now = new Date(2026, 5, 15, 12);
  expect(formatRelativeTime(new Date(2026, 5, 15, 11, 55).toISOString(), now)).toBe("5m ago");
  expect(formatRelativeTime(new Date(2025, 0, 15, 12).toISOString(), now)).toBe("Jan 15, 2025");
});
