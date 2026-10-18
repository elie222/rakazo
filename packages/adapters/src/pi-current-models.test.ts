import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { supplementPiModels } from "./pi-current-models.js";
import { listPiCatalog } from "./pi-models.js";
import { modelsForRequest } from "./pi-runtime.js";

describe("current model compatibility", () => {
  it.each([
    ["anthropic", "claude-sonnet-5-5"],
    ["openai-codex", "gpt-6.1-sol"],
  ])("exposes %s/%s in the picker and runtime with valid efforts", (provider, id) => {
    const model = modelsForRequest(
      { model: { provider, id } } as Parameters<typeof modelsForRequest>[0],
      provider,
    ).getModel(provider, id);
    expect(model).toBeDefined();
    expect(getSupportedThinkingLevels(model!)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(model?.input).toContain("image");
    expect(
      listPiCatalog().find((entry) => entry.provider === provider && entry.id === id)
        ?.thinkingLevels,
    ).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
  it.each([
    ["opencode", "claude-haiku-5-5", "claude-haiku-4-5"],
    ["opencode", "claude-sonnet-5-5", "claude-sonnet-5"],
    ["opencode-go", "claude-haiku-5-5", "minimax-m3"],
  ])(
    "exposes %s/%s in the picker and runtime on the same endpoint as %s",
    (provider, id, baseId) => {
      const models = modelsForRequest(
        { model: { provider, id } } as Parameters<typeof modelsForRequest>[0],
        provider,
      );
      const model = models.getModel(provider, id);
      const base = models.getModel(provider, baseId);
      expect(model).toBeDefined();
      expect(model?.baseUrl).toBe(base?.baseUrl);
      expect(model?.api).toBe(base?.api);
      expect(model?.input).toContain("image");
      expect(model?.contextWindow).toBe(1000000);
      const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
      expect(getSupportedThinkingLevels(model!)).toEqual(levels);
      expect(
        listPiCatalog().find((entry) => entry.provider === provider && entry.id === id)
          ?.thinkingLevels,
      ).toEqual(levels);
    },
  );
  it("does not replace a provider library model when applying the supplement again", () => {
    const models = supplementPiModels(builtinModels());
    const model = models.getModel("anthropic", "claude-sonnet-5-5");
    supplementPiModels(models);
    expect(models.getModel("anthropic", "claude-sonnet-5-5")).toBe(model);
    expect(model?.compat).toMatchObject({
      forceAdaptiveThinking: true,
      supportsTemperature: false,
      supportsStrictTools: true,
      supportsMidConvoEffort: true,
      supportsMidConvoSystemMessages: true,
      supportsMidConvoToolChanges: true,
    });
  });
});
