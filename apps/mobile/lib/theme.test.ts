import { describe, expect, it } from "vitest";
import { botColors, tokens } from "./theme.js";

describe("mobile theme tokens", () => {
  it("exposes the shared product palette used by custom surfaces", () => {
    expect(tokens.background).toBe("#0D0D0E");
    expect(tokens.foreground).toBe("#ECECEE");
    expect(tokens.primary).toBe("#F1F1EF");
  });

  it("re-exports botColors for identity accents", () => {
    expect(botColors.length).toBeGreaterThan(0);
    expect(botColors[0]).toBe("#3EC5A8");
  });
});
