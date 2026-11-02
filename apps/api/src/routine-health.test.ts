import { routineScheduleDelay } from "@rakazo/core";
import { describe, expect, it } from "vitest";

describe("routine schedule delay", () => {
  const now = new Date("2026-11-01T06:30:00Z");
  it("marks only an active schedule beyond the grace period", () => {
    expect(routineScheduleDelay(true, new Date("2026-11-01T06:25:00Z"), now)).toBe(false);
    expect(routineScheduleDelay(true, new Date("2026-11-01T06:24:59Z"), now)).toBe(true);
    expect(routineScheduleDelay(false, new Date("2026-11-01T06:00:00Z"), now)).toBe(false);
    expect(routineScheduleDelay(true, null, now)).toBe(false);
  });
  it("does not flag a future backoff, including across a daylight saving transition", () => {
    expect(routineScheduleDelay(true, new Date("2026-11-01T07:00:00Z"), now)).toBe(false);
  });
});
