import { describe, expect, it } from "vitest";
import { fitPageState } from "./page-reader-state.js";

describe("fitPageState", () => {
  it("moves changed keys to the end and drops the oldest when the limit is reached", () => {
    const saved = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`k${index}`, index]),
    );
    const fitted = fitPageState(saved, { k5: "again", fresh: true });
    expect(Object.keys(fitted)).toHaveLength(100);
    expect(fitted).not.toHaveProperty("k0");
    expect(Object.keys(fitted).slice(-2)).toEqual(["k5", "fresh"]);
  });

  it("drops old values until the new ones fit in the size limit", () => {
    const fitted = fitPageState(
      { old: "x".repeat(40_000), recent: "y" },
      { note: "z".repeat(30_000) },
    );
    expect(Object.keys(fitted)).toEqual(["recent", "note"]);
  });
});
