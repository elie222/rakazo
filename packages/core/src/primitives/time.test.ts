import { describe, expect, it } from "vitest";
import { isEndOfZonedDay, zonedDateTime, zonedEndDateTime } from "./time.js";

describe("zonedDateTime", () => {
  it("reads a wall-clock time or date without an offset in the timezone", () => {
    expect(zonedDateTime("2026-11-02T10:00", "Europe/Berlin")?.toISOString()).toBe(
      "2026-11-02T09:00:00.000Z",
    );
    expect(zonedDateTime("2026-11-02 10:00:30", "UTC")?.toISOString()).toBe(
      "2026-11-02T10:00:30.000Z",
    );
    expect(zonedDateTime("2026-11-02T10:00:00.5", "Europe/Berlin")?.toISOString()).toBe(
      "2026-11-02T09:00:00.500Z",
    );
    expect(zonedDateTime("2026-11-02", "America/Los_Angeles")?.toISOString()).toBe(
      "2026-11-02T08:00:00.000Z",
    );
  });

  it("takes a time with an offset as written", () => {
    expect(zonedDateTime("2026-11-02T10:00:00Z", "Europe/Berlin")?.toISOString()).toBe(
      "2026-11-02T10:00:00.000Z",
    );
    expect(zonedDateTime("2026-11-02T10:00+05:00", "Europe/Berlin")?.toISOString()).toBe(
      "2026-11-02T05:00:00.000Z",
    );
  });

  it.each([
    ["0099-03-01T10:00Z", "0099-03-01T10:00:00.000Z"],
    ["2028-02-29T10:00Z", "2028-02-29T10:00:00.000Z"],
    ["2030-03-01t10:00z", "2030-03-01T10:00:00.000Z"],
    ["2030-03-01T00:30:15.125+05:30", "2030-02-28T19:00:15.125Z"],
    ["2030-02-28T23:30-04:00", "2030-03-01T03:30:00.000Z"],
    ["2030-03-01T00:30+0530", "2030-02-28T19:00:00.000Z"],
    ["2030-03-01T00:30+05", "2030-02-28T19:30:00.000Z"],
    ["2030-02-28T23:30:15-04", "2030-03-01T03:30:15.000Z"],
  ])("preserves the valid offset datetime %s", (value, expected) => {
    expect(zonedDateTime(value, "America/New_York")?.toISOString()).toBe(expected);
  });

  it.each([
    "2030-02-30T10:00Z",
    "2100-02-29T10:00Z",
    "2030-04-31T10:00-04:00",
    "2030-01-01T24:00Z",
    "2030-01-01T10:00+24:00",
    "2030-01-01T10:00+24",
    "2030-01-01T10:00+05:60",
  ])("rejects the impossible offset datetime %s", (value) => {
    expect(zonedDateTime(value, "UTC")).toBeNull();
  });

  it("moves a time skipped by daylight saving forward and keeps the first of a repeated hour", () => {
    expect(zonedDateTime("2026-03-29T02:30", "Europe/Berlin")?.toISOString()).toBe(
      "2026-03-29T01:30:00.000Z",
    );
    expect(zonedDateTime("2026-10-25T02:30", "Europe/Berlin")?.toISOString()).toBe(
      "2026-10-25T00:30:00.000Z",
    );
  });

  it("rejects impossible dates and non-ISO text", () => {
    for (const value of ["2026-02-30", "2026-11-02T24:00", "next monday", "", "2026-11-02T10"]) {
      expect(zonedDateTime(value, "UTC")).toBeNull();
    }
  });
});

describe("zonedEndDateTime", () => {
  it("ends a date alone at the last moment of that day in the timezone", () => {
    const end = zonedEndDateTime("2026-11-30", "America/New_York");
    expect(end?.toISOString()).toBe("2026-12-01T04:59:59.999Z");
    expect(end && isEndOfZonedDay(end, "America/New_York")).toBe(true);
  });

  it("reads a time as zonedDateTime does", () => {
    const end = zonedEndDateTime("2026-11-30T18:00", "America/New_York");
    expect(end?.toISOString()).toBe("2026-11-30T23:00:00.000Z");
    expect(end && isEndOfZonedDay(end, "America/New_York")).toBe(false);
  });
});
