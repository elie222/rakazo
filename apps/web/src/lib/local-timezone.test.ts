import { describe, expect, it } from "vitest";

import { localTimezone } from "./local-timezone.js";

describe("localTimezone", () => {
  it("returns the browser's IANA timezone", () => {
    const zone = localTimezone();
    expect(zone).not.toBe("");
    // IANA zones contain a slash; the UTC fallback does not.
    if (Intl.DateTimeFormat().resolvedOptions().timeZone) {
      expect(zone).toContain("/");
    }
  });

  it("matches what Intl reports", () => {
    expect(localTimezone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  });
});
