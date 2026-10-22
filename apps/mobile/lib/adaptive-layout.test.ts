import { describe, expect, it } from "vitest";
import {
  isCompactScreen,
  READABLE_COLUMN_WIDTH,
  readableGutter,
  readableGutters,
} from "./adaptive-layout";

describe("adaptive layout", () => {
  it("treats phones and folded cover screens as compact, unfolded screens as expanded", () => {
    expect(isCompactScreen({ width: 411, height: 914 })).toBe(true);
    // A phone turned sideways by a full-screen viewer is still a phone.
    expect(isCompactScreen({ width: 914, height: 411 })).toBe(true);
    expect(isCompactScreen({ width: 744, height: 840 })).toBe(false);
    expect(isCompactScreen({ width: 840, height: 744 })).toBe(false);
  });

  it("centres a readable column only when the window is wider than it", () => {
    expect(readableGutter(411)).toBe(0);
    expect(readableGutter(READABLE_COLUMN_WIDTH)).toBe(0);
    expect(readableGutter(1000)).toBe((1000 - READABLE_COLUMN_WIDTH) / 2);
  });

  it.each([599, 600, 601])(
    "keeps the %i dp screen boundary stable across rotation",
    (shortSide) => {
      expect(isCompactScreen({ width: shortSide, height: 960 })).toBe(shortSide < 600);
      expect(isCompactScreen({ width: 960, height: shortSide })).toBe(shortSide < 600);
    },
  );

  it("keeps clear of a cutout wider than the centring space", () => {
    expect(readableGutter(411, 24)).toBe(24);
    expect(readableGutter(1000, 24)).toBe((1000 - READABLE_COLUMN_WIDTH) / 2);
  });
});

it("preserves asymmetric safe edges and centres within the usable window", () => {
  expect(readableGutters(466, { left: 40, right: 8 })).toEqual({ left: 40, right: 8 });
  expect(readableGutters(951, { left: 40, right: 8 })).toEqual({ left: 131.5, right: 99.5 });
  expect(readableGutters(669, { left: 0, right: 44 })).toEqual({ left: 0, right: 44 });
  expect(readableGutters(402, { left: 0, right: 0 })).toEqual({ left: 0, right: 0 });
});
