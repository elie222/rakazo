import { describe, expect, it } from "vitest";
import { nextWaitUnit } from "./wait-pattern";

describe("nextWaitUnit", () => {
  it("never repeats the previous pattern, in either tone", () => {
    let last = 0;
    for (let i = 0; i < 500; i += 1) {
      const unit = nextWaitUnit(last);
      expect(unit.pattern).not.toBe(last);
      expect(unit.pattern).toBeGreaterThanOrEqual(1);
      expect(unit.pattern).toBeLessThanOrEqual(10);
      last = unit.pattern;
    }
  });

  it("picks both tones and every pattern", () => {
    const tones = new Set<string>();
    const patterns = new Set<number>();
    let last = 0;
    for (let i = 0; i < 2000; i += 1) {
      const unit = nextWaitUnit(last);
      tones.add(unit.tone);
      patterns.add(unit.pattern);
      last = unit.pattern;
    }
    expect([...tones].sort()).toEqual(["hollow", "wood"]);
    expect(patterns.size).toBe(10);
  });

  it("picks evenly from the nine patterns that are not the last one", () => {
    // With pattern 3 excluded, the nine slots map to 1, 2, 4, 5, ... 10.
    expect(nextWaitUnit(3, () => 0.05)).toEqual({ tone: "wood", pattern: 1 });
    expect(nextWaitUnit(3, () => 0.25)).toEqual({ tone: "wood", pattern: 4 });
    expect(nextWaitUnit(3, () => 0.99)).toEqual({ tone: "hollow", pattern: 10 });
    expect(nextWaitUnit(0, () => 0.99)).toEqual({ tone: "hollow", pattern: 10 });
  });
});
