import { afterEach, describe, expect, it, vi } from "vitest";

import { localTimezone } from "./local-timezone.js";

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
