import { workingAvatarDuration, workingAvatarFrame } from "@rakazo/core";
import { describe, expect, it } from "vitest";

describe("working avatar motion", () => {
  it("reuses shared core choreography", () => {
    const start = workingAvatarFrame(0, 0);
    const end = workingAvatarFrame(0, 1);
    expect(end.translationY).toBeCloseTo(start.translationY);
    expect(end.scaleX).toBeCloseTo(start.scaleX);
    expect(end.eyeOffsetX).toBeCloseTo(start.eyeOffsetX);
    expect(end.eyeOffsetY).toBeCloseTo(start.eyeOffsetY);
    expect(workingAvatarFrame(0, 0.5)).not.toEqual(workingAvatarFrame(0, 0));
    expect(workingAvatarFrame(2, 0.5)).not.toEqual(workingAvatarFrame(0, 0.5));
    expect(workingAvatarDuration(6)).toBe(1100);
  });
});
