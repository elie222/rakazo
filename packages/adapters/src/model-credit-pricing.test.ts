import { describe, expect, it } from "vitest";
import { maximumModelCallCost } from "./pi-usage.js";

describe("hosted model credit reservations", () => {
  it("covers the output limit and the highest context pricing tier", () => {
    expect(
      maximumModelCallCost(
        {
          input: 1,
          output: 2,
          cacheRead: 0.1,
          cacheWrite: 1.25,
          tiers: [
            { inputTokensAbove: 100000, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2.5 },
          ],
        },
        1000000,
        1000000,
      ),
    ).toBe(6.5);
  });
  it("reserves for long-lived prompt cache writes", () => {
    expect(
      maximumModelCallCost(
        { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
        1000000,
        0,
        "1h",
      ),
    ).toBe(2.5);
  });
  it("rejects unknown or invalid prices before a funded request", () => {
    expect(
      maximumModelCallCost(
        { input: Number.NaN, output: 2, cacheRead: 0.1, cacheWrite: 1 },
        100,
        100,
      ),
    ).toBeUndefined();
  });
});
