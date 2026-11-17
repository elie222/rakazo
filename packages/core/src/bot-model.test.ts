import type { ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { botModelState } from "./bot-model.js";

const credentials = [{ provider: "acme", label: "Acme" }] as unknown as ModelCredential[];
const catalog = [
  { provider: "acme", id: "fast", label: "Fast", thinkingLevels: ["off", "low", "high"] },
  { provider: "acme", id: "plain", label: "Plain" },
] as unknown as ModelCatalogEntry[];
const me = { defaultProvider: "acme", defaultModel: "fast" };

describe("botModelState", () => {
  it("offers the Space default's thinking levels while the bot follows it", () => {
    const state = botModelState({
      credentials,
      catalog,
      me,
      modelKey: "",
      spaceDefaultLabel: "Space default",
    });
    expect(state.selectedModelKey).toBe("");
    expect(state.defaultEntry?.label).toBe("Fast");
    expect(state.choices.map((choice) => choice.key)).toEqual(["", "acme::fast", "acme::plain"]);
    expect(state.thinkingLevels).toEqual(["low", "high"]);
    expect(state.defaultThinkingLevel).toBe("medium");
  });

  it("follows the bot's own model", () => {
    const state = botModelState({
      credentials,
      catalog,
      me,
      modelKey: "acme::plain",
      spaceDefaultLabel: "Space default",
    });
    expect(state.selectedModelKey).toBe("acme::plain");
    expect(state.thinkingLevels).toEqual([]);
  });
});
