import { describe, expect, it } from "vitest";
import { imageDismissBackdropOpacity, shouldDismissImage } from "./image-dismiss.js";

describe("shouldDismissImage", () => {
  it("springs back below both thresholds", () => {
    expect(shouldDismissImage(0, 0)).toBe(false);
    expect(shouldDismissImage(119, 999)).toBe(false);
    expect(shouldDismissImage(-119, -999)).toBe(false);
  });

  it("dismisses at the distance threshold in either direction", () => {
    for (const distance of [120, -120, 300, -300]) {
      expect(shouldDismissImage(distance, 0)).toBe(true);
    }
  });

  it("dismisses a fast vertical flick even over a short distance", () => {
    expect(shouldDismissImage(12, 1000)).toBe(true);
    expect(shouldDismissImage(-12, -1000)).toBe(true);
  });
});

describe("imageDismissBackdropOpacity", () => {
  it("starts opaque and fades proportionally in either direction", () => {
    expect(imageDismissBackdropOpacity(0)).toBe(1);
    expect(imageDismissBackdropOpacity(75)).toBe(0.75);
    expect(imageDismissBackdropOpacity(-150)).toBe(0.5);
  });

  it("stays transparent beyond the fade distance", () => {
    expect(imageDismissBackdropOpacity(300)).toBe(0);
    expect(imageDismissBackdropOpacity(-600)).toBe(0);
  });
});
