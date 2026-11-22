import { describe, expect, it } from "vitest";
import { settleMsArg } from "./tool-text.js";

describe("settleMsArg", () => {
  it.each([undefined, null, "", "soon", Number.NaN, {}])("uses 350 for %j", (value) => {
    expect(settleMsArg(value)).toBe(350);
  });

  it.each([
    [600, 600],
    ["600", 600],
    [0, 0],
  ])("keeps %j as %d", (value, expected) => {
    expect(settleMsArg(value)).toBe(expected);
  });
});
