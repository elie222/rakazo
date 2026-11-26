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
  it("shows the Space default's model and thinking levels while the bot follows it", () => {
    const state = botModelState({
      credentials,
      catalog,
      me,
      modelKey: "",
    });
    expect(state.selectedModelKey).toBe("");
    expect(state.defaultEntry?.label).toBe("Fast");
    expect(state.shownKey).toBe("acme::fast");
    expect(state.choices.map((choice) => choice.key)).toEqual(["acme::fast", "acme::plain"]);
    expect(state.thinkingLevels).toEqual(["low", "high"]);
    expect(state.defaultThinkingLevel).toBe("high");
  });

  it("names the level the model's own settings chose as its default", () => {
    const state = botModelState({
      credentials: [
        {
          provider: "acme",
          label: "Acme",
          modelId: "fast",
          modelSettings: { fast: { reasoning: true, thinkingLevel: "high" } },
        },
      ] as unknown as ModelCredential[],
      catalog,
      me,
      modelKey: "",
    });
    expect(state.defaultThinkingLevel).toBe("high");
  });

  it("lists off among the levels when it is the model's default", () => {
    const state = botModelState({
      credentials: [
        {
          provider: "acme",
          label: "Acme",
          modelId: "fast",
          modelSettings: { fast: { reasoning: true, thinkingLevel: "off" } },
        },
      ] as unknown as ModelCredential[],
      catalog,
      me,
      modelKey: "",
    });
    expect(state.defaultThinkingLevel).toBe("off");
    expect(state.thinkingLevels).toEqual(["off", "low", "high"]);
  });

  it("lists the Space default's model for a pinned bot even when no connection offers it", () => {
    const state = botModelState({
      credentials,
      catalog: [...catalog, { provider: "gone", id: "old", label: "Old" }] as ModelCatalogEntry[],
      me: { defaultProvider: "gone", defaultModel: "old" },
      modelKey: "acme::plain",
    });
    expect(state.choices.map((choice) => choice.key)).toEqual([
      "gone::old",
      "acme::fast",
      "acme::plain",
    ]);
    expect(state.savedModelKey("gone::old")).toBe("");
  });

  it("follows the bot's own model", () => {
    const state = botModelState({
      credentials,
      catalog,
      me,
      modelKey: "acme::plain",
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
    });
    expect(state.selectedName).toBe("Fast");
  });

  it("saves a pick of the Space default's model or its default level as following it", () => {
    const state = botModelState({ credentials, catalog, me, modelKey: "acme::plain" });
    expect(state.savedModelKey("acme::fast")).toBe("");
    expect(state.savedModelKey("acme::plain")).toBe("acme::plain");
    const following = botModelState({ credentials, catalog, me, modelKey: "" });
    expect(following.savedThinkingLevel("high")).toBeNull();
    expect(following.savedThinkingLevel("low")).toBe("low");
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
    });
    expect(unknown.selectedMark).toBeUndefined();
  });

  it("knows nothing is connected even while a disconnected model is still saved", () => {
    const state = botModelState({
      credentials: [],
      catalog,
      me,
      modelKey: "gone::old-model",
    });
    expect(state.choices.map((choice) => choice.key)).toEqual(["gone::old-model", "acme::fast"]);
    expect(state.nothingConnected).toBe(true);
  });
});
