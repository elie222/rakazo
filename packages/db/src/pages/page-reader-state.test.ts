import { describe, expect, it } from "vitest";
import { fitPageState } from "./page-reader-state.js";

describe("fitPageState", () => {
  it("moves changed keys to the end and drops the oldest when the limit is reached", () => {
    const saved = Array.from({ length: 100 }, (_, index): [string, unknown] => [
      `k${index}`,
      index,
    ]);
    const fitted = fitPageState(saved, { k5: "again", fresh: true });
    expect(fitted).toHaveLength(100);
    expect(fitted.map(([key]) => key)).not.toContain("k0");
    expect(fitted.slice(-2)).toEqual([
      ["k5", "again"],
      ["fresh", true],
    ]);
  });

  it("drops by when a value was set, whatever its key looks like", () => {
    const saved = Array.from({ length: 100 }, (_, index): [string, unknown] => [
      index === 99 ? "2" : `k${index}`,
      index,
    ]);
    const fitted = fitPageState(saved, { fresh: true }).map(([key]) => key);
    expect(fitted).toContain("2");
    expect(fitted).not.toContain("k0");
  });

  it("drops old values until the new ones fit in the size limit", () => {
    const fitted = fitPageState(
      [
        ["old", "x".repeat(40_000)],
        ["recent", "y"],
      ],
      { note: "z".repeat(30_000) },
    );
    expect(fitted.map(([key]) => key)).toEqual(["recent", "note"]);
  });
});
