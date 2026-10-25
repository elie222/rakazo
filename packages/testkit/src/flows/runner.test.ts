import { describe, expect, it } from "vitest";
import { wakeIsDue } from "./runner.js";

const now = Date.parse("2026-10-25T12:00:00Z");
const day = 24 * 60 * 60 * 1000;

describe("forcing a routine wake", () => {
  it("wakes a routine due within the horizon", () => {
    expect(wakeIsDue(new Date(now + day), now, 3 * day)).toBe(true);
    expect(wakeIsDue(new Date(now - 1000), now, 3 * day)).toBe(true);
  });

  it("leaves a routine started later than the horizon alone", () => {
    expect(wakeIsDue(new Date(now + 8 * day), now, 3 * day)).toBe(false);
  });

  it("never wakes a routine with no next run, and always wakes without a horizon", () => {
    expect(wakeIsDue(null, now, 3 * day)).toBe(false);
    expect(wakeIsDue(new Date(now + 30 * day), now)).toBe(true);
  });
});
