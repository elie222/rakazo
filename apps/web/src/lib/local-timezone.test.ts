import { describe, expect, it } from "vitest";

import { localTimezone } from "./local-timezone.js";

describe("localTimezone", () => {
  it("returns the environment's IANA timezone, falling back to UTC", () => {
    // CI runners legitimately resolve to "UTC", so assert against Intl itself.
    expect(localTimezone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  });
});
