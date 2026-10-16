import { describe, expect, it } from "vitest";
import { isCompactWindow, READABLE_COLUMN_WIDTH, readableGutter } from "./adaptive-layout";

describe("adaptive layout", () => {
  it("treats phones and folded cover screens as compact, unfolded screens as expanded", () => {
    expect(isCompactWindow({ width: 411, height: 914 })).toBe(true);
    // A phone turned sideways by a full-screen viewer is still a phone.
    expect(isCompactWindow({ width: 914, height: 411 })).toBe(true);
    expect(isCompactWindow({ width: 744, height: 840 })).toBe(false);
    expect(isCompactWindow({ width: 840, height: 744 })).toBe(false);
  });

  it("centres a readable column only when the window is wider than it", () => {
    expect(readableGutter(411)).toBe(0);
    expect(readableGutter(READABLE_COLUMN_WIDTH)).toBe(0);
    expect(readableGutter(1000)).toBe((1000 - READABLE_COLUMN_WIDTH) / 2);
  });

  it("keeps clear of a cutout wider than the centring space", () => {
    expect(readableGutter(411, 24)).toBe(24);
    expect(readableGutter(1000, 24)).toBe((1000 - READABLE_COLUMN_WIDTH) / 2);
  });
});
