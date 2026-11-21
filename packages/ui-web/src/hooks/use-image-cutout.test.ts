import { describe, expect, it } from "vitest";
import { hasCutoutCorners } from "./use-image-cutout.js";

describe("hasCutoutCorners", () => {
  it("treats a picture with any two see-through corners as a cutout", () => {
    expect(hasCutoutCorners([0, 0, 0, 0])).toBe(true);
    expect(hasCutoutCorners([0, 0, 255, 255])).toBe(true);
    expect(hasCutoutCorners([0, 255, 255, 0])).toBe(true);
  });

  it("keeps the frame for a full picture", () => {
    expect(hasCutoutCorners([255, 255, 255, 255])).toBe(false);
    expect(hasCutoutCorners([0, 255, 255, 255])).toBe(false);
    expect(hasCutoutCorners([128, 128, 128, 128])).toBe(false);
  });
});
