import { describe, expect, it } from "vitest";
import { helperHeaderOffset, helperOpenTarget } from "./helper-header-offset";

describe("helperHeaderOffset", () => {
  it("compensates for an expanding card moving above the header", () => {
    expect(helperHeaderOffset(0, 500, -200)).toBe(700);
  });
  it("keeps the header stationary when folding away from the newest message", () => {
    expect(helperHeaderOffset(700, 500, 1200)).toBe(0);
  });
  it("leaves an anchored header alone and never scrolls past the newest message", () => {
    expect(helperHeaderOffset(80, 300, 300)).toBe(80);
    expect(helperHeaderOffset(0, 300, 400)).toBe(0);
  });
});

describe("helperOpenTarget", () => {
  it.each([
    ["keeps a card that fits in place", 300, 550, 300],
    ["moves up by overflow when there is room", 300, 650, 250],
    ["clamps a tall card's header at the top limit", 300, 900, 100],
    ["moves a header above the top limit down to it", 50, 550, 100],
  ])("%s", (_name, headerY, cardBottom, target) => {
    expect(helperOpenTarget({ headerY, cardBottom, topLimit: 100, visibleBottom: 600 })).toBe(
      target,
    );
  });
});
