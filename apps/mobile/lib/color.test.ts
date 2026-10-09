import { darkTokens, lightTokens } from "@rakazo/ui-tokens";
import { describe, expect, it } from "vitest";
import { transparentColor } from "./color.js";

describe("transparentColor", () => {
  it("keeps the hue of six-digit backgrounds", () => {
    expect(transparentColor(darkTokens.background)).toBe("rgba(11, 12, 14, 0)");
    expect(transparentColor(lightTokens.background)).toBe("rgba(250, 250, 248, 0)");
  });

  it("reads rgba palette colors and drops their alpha", () => {
    expect(transparentColor(darkTokens.overlay)).toBe("rgba(4, 4, 5, 0)");
    expect(transparentColor(lightTokens.overlay)).toBe("rgba(20, 20, 22, 0)");
    expect(transparentColor("rgb(1, 2, 3)")).toBe("rgba(1, 2, 3, 0)");
  });

  it("expands short hex and ignores an existing hex alpha", () => {
    expect(transparentColor("#abc")).toBe("rgba(170, 187, 204, 0)");
    expect(transparentColor("#0B0C0E80")).toBe("rgba(11, 12, 14, 0)");
  });

  it("stays a valid color when the source format is unknown", () => {
    expect(transparentColor("oklch(0.2 0.02 260)")).toBe("transparent");
  });
});
