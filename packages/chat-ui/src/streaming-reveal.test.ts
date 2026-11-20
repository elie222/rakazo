import { describe, expect, it } from "vitest";
import { isIncrementalRevealSource, segmentRevealUnits } from "./streaming-reveal";

describe("streaming reveal units", () => {
  it("reveals Chinese and Japanese by character", () => {
    expect(segmentRevealUnits("拍板决策")).toEqual(["拍", "板", "决", "策"]);
    expect(segmentRevealUnits("こんにちは")).toEqual(["こ", "ん", "に", "ち", "は"]);
  });

  it("reveals Latin text by word and keeps whitespace between units", () => {
    const units = segmentRevealUnits("Hello, world!");
    expect(units.join("")).toBe("Hello, world!");
    expect(units).toContain("Hello");
    expect(units).toContain("world");
    expect(units.filter((unit) => unit.trim().length === 0)).toEqual([" "]);
  });
});

describe("streaming reveal source", () => {
  it("treats a short append as a live delta", () => {
    expect(isIncrementalRevealSource("First reply", "First reply continues")).toBe(true);
  });

  it("ignores an unchanged or replaced source", () => {
    expect(isIncrementalRevealSource("Same", "Same")).toBe(false);
    expect(isIncrementalRevealSource("A first reply.", "A different conversation.")).toBe(false);
  });

  it("treats a large jump as a mount or backfill instead of animating it", () => {
    expect(isIncrementalRevealSource("", "x".repeat(601))).toBe(false);
  });
});
