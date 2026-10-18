import { describe, expect, it } from "vitest";

import { localTimezone, sameTimeZone, timezoneOptions } from "./local-timezone.js";

describe("localTimezone", () => {
  it("returns a non-empty IANA timezone string", () => {
    const zone = localTimezone();
    expect(zone).not.toBe("");
    expect(zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  });
});

describe("sameTimeZone", () => {
  it("matches a zone with its legacy alias but not a different zone", () => {
    expect(sameTimeZone("Asia/Kolkata", "Asia/Calcutta")).toBe(true);
    expect(sameTimeZone("Pacific/Auckland", "Pacific/Auckland")).toBe(true);
    expect(sameTimeZone("Pacific/Auckland", "Europe/London")).toBe(false);
  });
});

describe("timezoneOptions", () => {
  it("always offers UTC and the current zone, sorted", () => {
    const zones = timezoneOptions("Etc/GMT+5");
    expect(zones).toContain("UTC");
    expect(zones).toContain("Etc/GMT+5");
    expect(zones).toEqual([...zones].sort((a, b) => a.localeCompare(b)));
  });
});
