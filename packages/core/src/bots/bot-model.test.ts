import type { ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { botModelPick, botModelState } from "./bot-model.js";

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

  it("names the model without its catalog vendor prefix", () => {
    const state = botModelState({
      credentials,
      catalog: [
        { provider: "acme", id: "fast", label: "Vendor: Fast" },
        { provider: "acme", id: "plain", label: "Plain" },
      ] as unknown as ModelCatalogEntry[],
      me,
      modelKey: "",
      spaceDefaultLabel: "Space default",
    });
    expect(state.selectedName).toBe("Fast");
  });

  it("turns a pick into the bot update, starting the new model on its default thinking", () => {
    expect(botModelPick("acme::fast")).toEqual({
      modelProvider: "acme",
      modelId: "fast",
      thinkingLevel: null,
    });
    expect(botModelPick("")).toEqual({ modelProvider: null, modelId: null, thinkingLevel: null });
  });

  it("marks the model with its maker's mark, through a router too", () => {
    const routed = botModelState({
      credentials: [{ provider: "router", label: "Router" }] as unknown as ModelCredential[],
      catalog: [
        { provider: "router", id: "anthropic/claude-x", label: "Anthropic: Claude X" },
        { provider: "router", id: "unknown/model", label: "Model" },
      ] as unknown as ModelCatalogEntry[],
      me: { defaultProvider: "router", defaultModel: "anthropic/claude-x" },
      modelKey: "",
      spaceDefaultLabel: "Space default",
    });
    expect(routed.selectedMark).toBeDefined();
    // The mark stands for "Claude", so the name leaves it off.
    expect(routed.selectedName).toBe("X");
    const unknown = botModelState({
      credentials: [{ provider: "router", label: "Router" }] as unknown as ModelCredential[],
      catalog: [
        { provider: "router", id: "unknown/model", label: "Model" },
      ] as unknown as ModelCatalogEntry[],
      me,
      modelKey: "router::unknown/model",
      spaceDefaultLabel: "Space default",
    });
    expect(unknown.selectedMark).toBeUndefined();
  });

  it("knows nothing is connected even while a disconnected model is still saved", () => {
    const state = botModelState({
      credentials: [],
      catalog,
      me,
      modelKey: "gone::old-model",
      spaceDefaultLabel: "Space default",
    });
    expect(state.choices.length).toBe(2);
    expect(state.nothingConnected).toBe(true);
  });
});
