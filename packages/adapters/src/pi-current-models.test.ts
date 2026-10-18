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
    ["us.anthropic.claude-sonnet-5-5", "us.anthropic.claude-sonnet-5"],
    ["global.anthropic.claude-haiku-5-5", "global.anthropic.claude-sonnet-5"],
    ["us.openai.gpt-6.1-sol", "us.openai.gpt-6-astra"],
  ])("lists Bedrock %s with the endpoint and efforts of %s", (id, baseId) => {
    const catalog = listPiCatalog();
    const levels = (modelId: string) =>
      catalog.find((entry) => entry.provider === "amazon-bedrock" && entry.id === modelId)
        ?.thinkingLevels;
    expect(levels(id)).toBeDefined();
    expect(levels(id)).toEqual(levels(baseId));
    const models = supplementPiModels(builtinModels());
    const model = models.getModel("amazon-bedrock", id);
    expect(model?.baseUrl).toBe(models.getModel("amazon-bedrock", baseId)?.baseUrl);
    expect(model?.input).toContain("image");
  });
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
