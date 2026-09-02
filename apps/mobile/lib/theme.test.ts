import { describe, expect, it } from "vitest";
import { botColors, tokens } from "./theme.js";

describe("mobile theme tokens", () => {
  it("exposes the shared product page color used by screen backgrounds", () => {
    expect(tokens.page).toBe("#050506");
    expect(tokens.ink).toBe("#ECECEE");
    expect(tokens.cream).toBe("#F1F1EF");
    expect(tokens.accent).toBe("#3EC5A8");
  });

  it("re-exports botColors for identity accents", () => {
    expect(botColors.length).toBeGreaterThan(0);
    expect(botColors[0]).toBe(tokens.accent);
  });
});
