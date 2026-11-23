import { describe, expect, it } from "vitest";
import { READABLE_COLUMN_WIDTH, readableGutter, readableGutters } from "./adaptive-layout";

describe("adaptive layout", () => {
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

it("preserves asymmetric safe edges and centres within the usable window", () => {
  expect(readableGutters(466, { left: 40, right: 8 })).toEqual({ left: 40, right: 8 });
  expect(readableGutters(951, { left: 40, right: 8 })).toEqual({ left: 131.5, right: 99.5 });
  expect(readableGutters(669, { left: 0, right: 44 })).toEqual({ left: 0, right: 44 });
  expect(readableGutters(402, { left: 0, right: 0 })).toEqual({ left: 0, right: 0 });
});
