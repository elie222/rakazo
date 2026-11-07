import { afterEach, describe, expect, it, vi } from "vitest";

import { localTimezone, sameTimeZone, timezoneReportDue } from "./local-timezone.js";

/** The runtime's own zone lookup, pointed at a fixed zone for one assertion. */
function fakeRuntimeZone(zone?: string) {
  return vi.spyOn(Intl, "DateTimeFormat").mockImplementation((() => ({
    resolvedOptions: () => ({ timeZone: zone }),
  })) as unknown as typeof Intl.DateTimeFormat);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("localTimezone", () => {
  it("returns the runtime's zone and falls back to UTC when it names none", () => {
    fakeRuntimeZone("Pacific/Auckland");
    expect(localTimezone()).toBe("Pacific/Auckland");
    fakeRuntimeZone(undefined);
    expect(localTimezone()).toBe("UTC");
  });
});

describe("sameTimeZone", () => {
  it("matches a zone with its legacy alias but not a different zone", () => {
    expect(sameTimeZone("Asia/Kolkata", "Asia/Calcutta")).toBe(true);
    expect(sameTimeZone("Pacific/Auckland", "Pacific/Auckland")).toBe(true);
    expect(sameTimeZone("Pacific/Auckland", "Europe/London")).toBe(false);
    expect(sameTimeZone(null, null)).toBe(true);
    expect(sameTimeZone(null, "UTC")).toBe(false);
  });
});

describe("timezoneReportDue", () => {
  it("is due unless the source is manual or the server holds the same zone", () => {
    expect(timezoneReportDue("Europe/London", "Pacific/Auckland", "device")).toBe(true);
    expect(timezoneReportDue("Europe/London", null, null)).toBe(true);
    expect(timezoneReportDue("Europe/London", undefined, undefined)).toBe(true);
    expect(timezoneReportDue("Asia/Kolkata", "Asia/Calcutta", "device")).toBe(false);
    expect(timezoneReportDue("Europe/London", "Europe/London", "device")).toBe(false);
    expect(timezoneReportDue("Europe/London", "Pacific/Auckland", "manual")).toBe(false);
  });
});
