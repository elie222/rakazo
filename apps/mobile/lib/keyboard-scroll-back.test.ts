import { describe, expect, it } from "vitest";
import { KeyboardScrollBack } from "./keyboard-scroll-back.js";

describe("keyboard dismissal on a scroll toward older messages", () => {
  it("fires once per drag when an inverted list moves toward older messages", () => {
    const back = new KeyboardScrollBack("increasing");
    back.onDragStart(100);

    expect(back.onScroll(120)).toBe(true);
    expect(back.onScroll(140)).toBe(false);
    expect(back.onScroll(160)).toBe(false);
  });

  it("stays quiet when an inverted list moves toward newer messages", () => {
    const back = new KeyboardScrollBack("increasing");
    back.onDragStart(100);

    expect(back.onScroll(80)).toBe(false);
    expect(back.onScroll(60)).toBe(false);
  });

  it("ignores a move under the threshold", () => {
    const back = new KeyboardScrollBack("increasing");
    back.onDragStart(100);

    expect(back.onScroll(104)).toBe(false);
    expect(back.onScroll(108)).toBe(false);
  });

  it("mirrors the direction for a non-inverted list", () => {
    const back = new KeyboardScrollBack("decreasing");
    back.onDragStart(100);

    expect(back.onScroll(120)).toBe(false);
    expect(back.onScroll(80)).toBe(true);
    expect(back.onScroll(60)).toBe(false);
  });

  it("re-arms on a new drag", () => {
    const back = new KeyboardScrollBack("increasing");
    back.onDragStart(100);
    expect(back.onScroll(120)).toBe(true);
    back.onDragEnd();

    expect(back.onScroll(200)).toBe(false);
    back.onDragStart(200);
    expect(back.onScroll(220)).toBe(true);
  });

  it("does nothing when no drag has started", () => {
    const back = new KeyboardScrollBack("increasing");

    expect(back.onScroll(120)).toBe(false);
    expect(back.onScroll(500)).toBe(false);
  });
});
