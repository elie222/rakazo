import { describe, expect, it } from "vitest";
import { estimateRowLayout, jumpOffset, offscreenUnreads, visibleRange } from "./offscreen-unreads";

const read = { unread: 0, attention: 0 };
const unread = { unread: 1, attention: 0 };
const waiting = { unread: 0, attention: 1 };

describe("visibleRange", () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({ y: index * 100, height: 100 }));

  it("counts rows at least half inside the viewport, after the insets", () => {
    // The viewport shows 140..390: row 1 is 60% in, row 3 is 90% in, row 4 is under the edge.
    expect(visibleRange(rows, { top: 140, bottom: 390 })).toEqual({ first: 1, last: 3 });
    expect(visibleRange(rows, { top: 160, bottom: 340 })).toEqual({ first: 2, last: 2 });
  });

  it("handles a taller pinned strip and rows obscured by the bottom safe area", () => {
    const rows = [
      { y: 0, height: 180 },
      { y: 180, height: 60 },
      { y: 240, height: 100 },
    ];
    expect(visibleRange(rows, { top: 100, bottom: 280 })).toEqual({ first: 1, last: 1 });
    expect(visibleRange(rows, { top: 0, bottom: 280 })).toEqual({ first: 0, last: 1 });
  });

  it("places an empty range where the viewport is when no row is on screen", () => {
    // The list header (activity) fills the screen: every row starts below it.
    const below = [
      { y: 900, height: 100 },
      { y: 1000, height: 100 },
    ];
    expect(visibleRange(below, { top: 0, bottom: 800 })).toEqual({ first: 0, last: -1 });
    // Scrolled past every row, into the footer: every row is above.
    expect(visibleRange(below, { top: 1200, bottom: 2000 })).toEqual({ first: 2, last: 1 });
    // A row only a sliver on screen still counts on the side it hangs off.
    expect(visibleRange(below, { top: 0, bottom: 920 })).toEqual({ first: 0, last: -1 });
  });

  it("counts every unread chat below when only the list header is on screen", () => {
    const rows = [
      { y: 900, height: 100 },
      { y: 1000, height: 100 },
      { y: 1100, height: 100 },
    ];
    const range = visibleRange(rows, { top: 0, bottom: 800 });
    expect(range).toBeDefined();
    expect(
      offscreenUnreads(
        [
          { unread: 1, attention: 0 },
          { unread: 0, attention: 0 },
          { unread: 1, attention: 0 },
        ],
        range!,
      ),
    ).toEqual({ below: { kind: "unread", count: 2, index: 0 } });
  });

  it("has no range before any row is measured", () => {
    expect(visibleRange([], { top: 0, bottom: 500 })).toBeUndefined();
    expect(visibleRange([undefined, undefined], { top: 0, bottom: 500 })).toBeUndefined();
  });
});

describe("offscreenUnreads", () => {
  it("counts unread chats on each side and targets the nearest one", () => {
    const signals = [unread, read, unread, read, read, read, unread, unread];
    expect(offscreenUnreads(signals, { first: 3, last: 5 })).toEqual({
      above: { kind: "unread", count: 2, index: 2 },
      below: { kind: "unread", count: 2, index: 6 },
    });
  });

  it("ignores unread chats on screen and shows nothing when none are off it", () => {
    expect(offscreenUnreads([read, unread, read], { first: 0, last: 2 })).toEqual({});
  });

  it("lets a chat waiting on you outrank unread ones on that side", () => {
    const signals = [read, read, read, unread, waiting, unread];
    expect(offscreenUnreads(signals, { first: 0, last: 2 }).below).toEqual({
      kind: "attention",
      count: 1,
      index: 4,
    });
  });

  it("targets the nearest waiting chat above, including a mixed pinned strip", () => {
    expect(
      offscreenUnreads([{ unread: 2, attention: 2 }, waiting, unread, read], { first: 3, last: 3 })
        .above,
    ).toEqual({ kind: "attention", count: 3, index: 1 });
  });

  it("counts every chat a pinned strip holds", () => {
    expect(offscreenUnreads([{ unread: 2, attention: 0 }, read], { first: 1, last: 1 })).toEqual({
      above: { kind: "unread", count: 2, index: 0 },
    });
  });
});

describe("jumpOffset", () => {
  const metrics = {
    viewportHeight: 800,
    contentHeight: 3000,
    topInset: 100,
    bottomInset: 34,
    pillSpace: 50,
    isLast: false,
  };

  it("brings a row below to the top, under the upper pill", () => {
    expect(jumpOffset("below", { y: 1200, height: 80 }, metrics)).toBe(1050);
  });

  it("brings a row above to the bottom, over the lower pill", () => {
    expect(jumpOffset("above", { y: 1000, height: 80 }, metrics)).toBe(364);
  });

  it("uses the same unobscured edges for nonfloating headers and gesture navigation", () => {
    expect(jumpOffset("below", { y: 1200, height: 150 }, { ...metrics, topInset: 0 })).toBe(1150);
    expect(jumpOffset("above", { y: 1000, height: 150 }, { ...metrics, topInset: 0 })).toBe(434);
  });

  it("lands the last row flush at the bottom and never scrolls past either end", () => {
    expect(jumpOffset("below", { y: 2920, height: 80 }, { ...metrics, isLast: true })).toBe(2234);
    expect(jumpOffset("above", { y: 0, height: 80 }, metrics)).toBe(-100);
    expect(jumpOffset("below", { y: 2900, height: 80 }, metrics)).toBe(2234);
  });
});

describe("estimateRowLayout", () => {
  it("uses the default row height before measurements exist", () => {
    expect(estimateRowLayout([], 10)).toEqual({ y: 720, height: 72 });
  });

  it("averages variable-height rows including the pinned strip", () => {
    const rows = [
      { y: 0, height: 180 },
      { y: 180, height: 60 },
    ];
    expect(estimateRowLayout(rows, 8)).toEqual({ y: 960, height: 120 });
    expect(estimateRowLayout(rows, 0)).toEqual({ y: 0, height: 120 });
  });
});
