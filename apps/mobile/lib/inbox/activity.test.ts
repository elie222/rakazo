import { afterEach, expect, it, vi } from "vitest";
import { resetI18nForTests } from "../i18n/i18n";
import { formatActivityRelativeTime } from "./activity";

vi.mock("../api/api", () => ({ rpc: vi.fn() }));
afterEach(() => resetI18nForTests());

it("formats older dates in the active language", () => {
  resetI18nForTests("de");
  const now = new Date(2026, 5, 15, 12);
  const previous = new Date(2025, 0, 15, 12);
  expect(formatActivityRelativeTime(previous.toISOString(), now)).toBe(
    previous.toLocaleDateString("de", { day: "numeric", month: "short", year: "numeric" }),
  );
});
