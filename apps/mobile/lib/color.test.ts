import { darkTokens, lightTokens } from "@rakazo/ui-tokens";
import { describe, expect, it } from "vitest";
import { translucentColor } from "./color.js";

describe("translucentColor", () => {
  it("keeps the hue of six-digit backgrounds", () => {
    expect(translucentColor(darkTokens.background, 0)).toBe("rgba(22, 22, 22, 0)");
    expect(translucentColor(lightTokens.background, 0)).toBe("rgba(250, 250, 250, 0)");
  });

  it("reads rgba palette colors and replaces their alpha", () => {
    expect(translucentColor(darkTokens.overlay, 0)).toBe("rgba(0, 0, 0, 0)");
    expect(translucentColor(lightTokens.overlay, 0)).toBe("rgba(0, 0, 0, 0)");
    expect(translucentColor("rgb(1, 2, 3)", 0)).toBe("rgba(1, 2, 3, 0)");
  });

  it("expands short hex and ignores an existing hex alpha", () => {
    expect(translucentColor("#abc", 0)).toBe("rgba(170, 187, 204, 0)");
    expect(translucentColor("#0B0C0E80", 0)).toBe("rgba(11, 12, 14, 0)");
  });

  it("gives the label grey at 30% in both themes", () => {
    expect(translucentColor(lightTokens.mutedForeground, 0.3)).toBe("rgba(95, 95, 95, 0.3)");
    expect(translucentColor(darkTokens.mutedForeground, 0.3)).toBe("rgba(158, 158, 158, 0.3)");
  });

  it("leaves a colour it can't read as it was", () => {
    expect(translucentColor("oklch(0.2 0.02 260)", 0.3)).toBe("oklch(0.2 0.02 260)");
  });
});
