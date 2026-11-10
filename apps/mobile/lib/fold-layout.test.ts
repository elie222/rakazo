import { describe, expect, it } from "vitest";
import { crossesWindow, tabletopLayout } from "./fold-layout";

describe("tabletop layout", () => {
  const hinge = { x: 0, y: 465, width: 669, height: 21 };

  it("keeps the top above a horizontal fold and the hinge below it", () => {
    expect(tabletopLayout(669, 951, [hinge])).toEqual({ top: 465, gap: 21 });
  });

  it("ignores a book-like vertical fold and a flat window", () => {
    expect(tabletopLayout(951, 669, [{ x: 465, y: 0, width: 21, height: 669 }])).toBeNull();
    expect(tabletopLayout(669, 951, [])).toBeNull();
  });

  it("ignores a fold that leaves a half too short to use", () => {
    expect(tabletopLayout(669, 951, [{ ...hinge, y: 100 }])).toBeNull();
    expect(tabletopLayout(669, 951, [{ ...hinge, y: 851 }])).toBeNull();
  });

  it("ignores a malformed or off-window frame", () => {
    expect(tabletopLayout(669, 951, [{ ...hinge, y: Number.NaN }])).toBeNull();
    expect(tabletopLayout(669, 951, [{ ...hinge, height: -21 }])).toBeNull();
    expect(tabletopLayout(669, 951, [{ ...hinge, x: 700 }])).toBeNull();
  });
});

it("accepts a zero-width division inside the window", () => {
  expect(crossesWindow({ x: 475, y: 0, width: 0, height: 669 }, 951, 669)).toBe(true);
  expect(crossesWindow({ x: 475, y: 700, width: 0, height: 669 }, 951, 669)).toBe(false);
});
