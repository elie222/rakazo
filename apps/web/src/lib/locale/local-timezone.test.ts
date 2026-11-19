import { describe, expect, it } from "vitest";

import { timezoneOptions } from "./local-timezone.js";

describe("timezoneOptions", () => {
  it("always offers UTC and the current zone, sorted", () => {
    const zones = timezoneOptions("Etc/GMT+5");
    expect(zones).toContain("UTC");
    expect(zones).toContain("Etc/GMT+5");
    expect(zones).toEqual([...zones].sort((a, b) => a.localeCompare(b)));
  });
});
