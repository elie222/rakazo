import { describe, expect, it } from "vitest";
import { inQuietHours } from "./quiet-hours.js";

describe("quiet hours", () => {
  const night = { start: 22, end: 7 };

  it("runs past midnight when the end comes before the start", () => {
    expect(inQuietHours(night, "UTC", new Date("2026-11-11T21:59:00Z"))).toBe(false);
    expect(inQuietHours(night, "UTC", new Date("2026-11-11T22:00:00Z"))).toBe(true);
    expect(inQuietHours(night, "UTC", new Date("2026-11-12T00:00:00Z"))).toBe(true);
    expect(inQuietHours(night, "UTC", new Date("2026-11-12T06:59:00Z"))).toBe(true);
    expect(inQuietHours(night, "UTC", new Date("2026-11-12T07:00:00Z"))).toBe(false);
  });

  it("stays within the day when the start comes first", () => {
    const afternoon = { start: 13, end: 15 };
    expect(inQuietHours(afternoon, "UTC", new Date("2026-11-11T12:59:00Z"))).toBe(false);
    expect(inQuietHours(afternoon, "UTC", new Date("2026-11-11T14:30:00Z"))).toBe(true);
    expect(inQuietHours(afternoon, "UTC", new Date("2026-11-11T15:00:00Z"))).toBe(false);
  });

  it("reads the hours in the person's timezone", () => {
    // 21:30 UTC is 22:30 in Berlin in November, and 10:30 the next morning in Auckland.
    const at = new Date("2026-11-11T21:30:00Z");
    expect(inQuietHours(night, "Europe/Berlin", at)).toBe(true);
    expect(inQuietHours(night, "Pacific/Auckland", at)).toBe(false);
    expect(inQuietHours(night, "UTC", at)).toBe(false);
  });

  it("follows daylight saving time", () => {
    // 05:30 UTC is 06:30 in Berlin in winter and 07:30 in summer.
    expect(inQuietHours(night, "Europe/Berlin", new Date("2026-01-15T05:30:00Z"))).toBe(true);
    expect(inQuietHours(night, "Europe/Berlin", new Date("2026-07-15T05:30:00Z"))).toBe(false);
  });

  it("reads UTC without a timezone or with one this runtime doesn't know", () => {
    const at = new Date("2026-11-11T23:00:00Z");
    expect(inQuietHours(night, null, at)).toBe(true);
    expect(inQuietHours(night, "Not/AZone", at)).toBe(true);
  });

  it("is never quiet when off or without an end", () => {
    const at = new Date("2026-11-11T23:00:00Z");
    expect(inQuietHours(null, "UTC", at)).toBe(false);
    expect(inQuietHours(undefined, "UTC", at)).toBe(false);
    expect(inQuietHours({ start: 23, end: 23 }, "UTC", at)).toBe(false);
  });
});
