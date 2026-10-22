import { describe, expect, it } from "vitest";
import { fontWeight, typeScale } from "./index.js";

describe("typeScale", () => {
  it("sets message text at the iOS body size", () => {
    expect(typeScale.body).toEqual({ fontSize: 17, lineHeight: 22 });
  });

  it("gives every style a line height at least as tall as its text", () => {
    for (const style of Object.values(typeScale)) {
      expect(style.lineHeight).toBeGreaterThanOrEqual(style.fontSize);
    }
  });

  it("uses semibold titles and medium card titles", () => {
    expect(typeScale.title.fontWeight).toBe(fontWeight.semibold);
    expect(typeScale.headline.fontWeight).toBe(fontWeight.semibold);
    expect(typeScale.cardTitle).toEqual({ fontSize: 17, lineHeight: 22, fontWeight: "500" });
  });
});
