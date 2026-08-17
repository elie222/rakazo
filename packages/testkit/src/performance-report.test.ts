import { describe, expect, it } from "vitest";
import { percentageDelta, roundMetric, summarize } from "./performance-report";

describe("performance report statistics", () => {
  it("summarizes a distribution without mutating it", () => {
    const values = [40, 10, 30, 20];

    expect(summarize(values)).toEqual({
      count: 4,
      min: 10,
      median: 25,
      p95: 38.5,
      max: 40,
    });
    expect(values).toEqual([40, 10, 30, 20]);
  });

  it("calculates comparable percentage deltas", () => {
    expect(percentageDelta(100, 75)).toBe(-25);
    expect(percentageDelta(0, 0)).toBe(0);
    expect(percentageDelta(0, 1)).toBeNull();
    expect(roundMetric(1.23456)).toBe(1.23);
  });

  it("rejects an empty distribution", () => {
    expect(() => summarize([])).toThrow("empty sample");
  });
});
