import { describe, expect, it } from "vitest";
import { KeyboardScrollBack } from "./keyboard-scroll-back.js";

function at(offset: number, content = 2000, viewport = 800) {
  return {
    contentOffset: { x: 0, y: offset },
    contentSize: { width: 400, height: content },
    layoutMeasurement: { width: 400, height: viewport },
  };
}

describe("keyboard dismissal on a scroll toward older messages", () => {
  it("fires once per drag when an inverted list moves toward older messages", () => {
    const back = new KeyboardScrollBack({ inverted: true });
    back.onDragStart(at(100));

    expect(back.onScroll(at(120))).toBe(true);
    expect(back.onScroll(at(140))).toBe(false);
    expect(back.onScroll(at(160))).toBe(false);
  });

  it("stays quiet when an inverted list moves toward newer messages", () => {
    const back = new KeyboardScrollBack({ inverted: true });
    back.onDragStart(at(100));

    expect(back.onScroll(at(80))).toBe(false);
    expect(back.onScroll(at(60))).toBe(false);
  });

  it("fires when a drag toward newer messages turns back toward older ones", () => {
    const back = new KeyboardScrollBack({ inverted: true });
    back.onDragStart(at(100));

    expect(back.onScroll(at(80))).toBe(false);
    expect(back.onScroll(at(90))).toBe(true);
  });

  it("ignores a move under the threshold", () => {
    const back = new KeyboardScrollBack({ inverted: true });
    back.onDragStart(at(100));

    expect(back.onScroll(at(104))).toBe(false);
    expect(back.onScroll(at(108))).toBe(false);
  });

  it("ignores an inverted list's offset shift from a message arriving at the newest end", () => {
    const back = new KeyboardScrollBack({ inverted: true });
    back.onDragStart(at(100, 2000));

    expect(back.onScroll(at(90, 2000))).toBe(false);
    expect(back.onScroll(at(150, 2060))).toBe(false);
    expect(back.onScroll(at(175, 2060))).toBe(true);
  });

  it("measures a non-inverted list from the top, where the oldest messages are", () => {
    const back = new KeyboardScrollBack({ inverted: false });
    back.onDragStart(at(100));

    expect(back.onScroll(at(120))).toBe(false);
    expect(back.onScroll(at(80))).toBe(true);
    expect(back.onScroll(at(60))).toBe(false);
  });

  it("ignores newer messages appended below a non-inverted list", () => {
    const back = new KeyboardScrollBack({ inverted: false });
    back.onDragStart(at(100, 2000));

    expect(back.onScroll(at(100, 3000))).toBe(false);
    expect(back.onScroll(at(80, 3000))).toBe(true);
  });

  it("re-arms on a new drag", () => {
    const back = new KeyboardScrollBack({ inverted: true });
    back.onDragStart(at(100));
    expect(back.onScroll(at(120))).toBe(true);
    back.onDragEnd();

    expect(back.onScroll(at(200))).toBe(false);
    back.onDragStart(at(200));
    expect(back.onScroll(at(220))).toBe(true);
  });

  it("stops tracking once the drag ends", () => {
    const back = new KeyboardScrollBack({ inverted: true });
    back.onDragStart(at(100));
    expect(back.onScroll(at(104))).toBe(false);
    back.onDragEnd();

    expect(back.onScroll(at(140))).toBe(false);
  });

  it("does nothing when no drag has started", () => {
    const back = new KeyboardScrollBack({ inverted: true });

    expect(back.onScroll(at(120))).toBe(false);
    expect(back.onScroll(at(500))).toBe(false);
  });
});
