import { describe, expect, it } from "vitest";
import { stacksAtTextScale } from "./text-scale";

// iOS font scales: xSmall … xxLarge, then xxxLarge and the five accessibility sizes.
describe("stacksAtTextScale", () => {
  it("keeps content side by side up to the xxLarge text size", () => {
    for (const fontScale of [0.823, 0.882, 0.941, 1, 1.118, 1.235]) {
      expect(stacksAtTextScale(fontScale)).toBe(false);
    }
  });

  it("stacks from the xxxLarge text size through the accessibility sizes", () => {
    for (const fontScale of [1.353, 1.786, 2.143, 2.643, 3.143, 3.571]) {
      expect(stacksAtTextScale(fontScale)).toBe(true);
    }
  });
});
