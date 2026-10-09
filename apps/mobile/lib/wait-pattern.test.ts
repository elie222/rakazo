import { describe, expect, it } from "vitest";
import { nextWaitUnit } from "./wait-pattern";

/** A fixed pseudo-random sequence, so every run sees the same picks. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 2 ** 32;
    return state / 2 ** 32;
  };
}

describe("nextWaitUnit", () => {
  it("never repeats the previous pattern, in either tone", () => {
    const random = seeded(7);
    let last = 0;
    for (let i = 0; i < 500; i += 1) {
      const unit = nextWaitUnit(last, random);
      expect(unit.pattern).not.toBe(last);
      expect(unit.pattern).toBeGreaterThanOrEqual(1);
      expect(unit.pattern).toBeLessThanOrEqual(10);
      last = unit.pattern;
    }
  });

  it("picks both tones and every pattern", () => {
    const random = seeded(42);
    const tones = new Set<string>();
    const patterns = new Set<number>();
    let last = 0;
    for (let i = 0; i < 200; i += 1) {
      const unit = nextWaitUnit(last, random);
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
