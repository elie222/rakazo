import { describe, expect, it } from "vitest";
import { scrollPoint } from "./computer-input.js";

describe("scrollPoint", () => {
  it("keeps the point a scroll was made at, in whole screen pixels", () => {
    expect(scrollPoint({ direction: "down", amount: 2, x: 600.4, y: 420 })).toEqual({
      x: 600,
      y: 420,
    });
  });

  it("drops a missing, partial or invalid point, so the wheel turns where the pointer is", () => {
    expect(scrollPoint({ direction: "down" })).toEqual({});
    expect(scrollPoint({ x: 600 })).toEqual({});
    expect(scrollPoint({ x: "left", y: 420 })).toEqual({});
    expect(scrollPoint({ x: -5, y: 420 })).toEqual({});
    expect(scrollPoint({ x: Number.POSITIVE_INFINITY, y: 420 })).toEqual({});
  });

  it.each([
    ["null", null],
    ["an empty string", ""],
    ["a blank string", " "],
    ["a boolean", true],
    ["an empty array", []],
  ])("does not read %s as a point at the top-left corner", (_label, bad) => {
    expect(scrollPoint({ x: bad, y: bad })).toEqual({});
    expect(scrollPoint({ x: 10, y: bad })).toEqual({});
  });

  it("still accepts a coordinate sent as a numeric string", () => {
    expect(scrollPoint({ x: "12.4", y: "0" })).toEqual({ x: 12, y: 0 });
  });
});
