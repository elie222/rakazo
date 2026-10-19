import { describe, expect, it } from "vitest";

import { localTimezone } from "./local-timezone.js";

describe("localTimezone", () => {
  it("returns a non-empty IANA timezone string", () => {
    const zone = localTimezone();
    expect(zone).not.toBe("");
    expect(zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  });
});
