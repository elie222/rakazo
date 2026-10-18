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
  it("disables strict tools only for the India Haiku 4.5 profile", () => {
    const models = supplementPiModels(builtinModels());
    const sibling = models.getModel(
      "amazon-bedrock",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
    const model = models.getModel("amazon-bedrock", "in.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(sibling?.compat).toMatchObject({ supportsStrictMode: true });
    expect(model?.compat).toEqual({ ...sibling?.compat, supportsStrictMode: false });
  });
  it.each([
    [
      "global.anthropic.claude-haiku-5-5",
      {
        input: 0.1,
        output: 0.5,
        cacheRead: 0.01,
        cacheWrite: 0.125,
        tiers: [
          { inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
        ],
      },
    ],
    [
      "us.openai.gpt-6.1-sol",
      {
        input: 2.2,
        output: 11,
        cacheRead: 0.11,
        cacheWrite: 2.75,
        tiers: [
          { inputTokensAbove: 272000, input: 4.4, output: 16.5, cacheRead: 0.22, cacheWrite: 5.5 },
        ],
      },
    ],
    [
      "eu.anthropic.claude-sonnet-5-5",
      { input: 2.2, output: 11, cacheRead: 0.11, cacheWrite: 2.75 },
    ],
  ] as const)("uses catalog prices for Bedrock %s", (id, cost) => {
    const models = supplementPiModels(builtinModels());
    expect(models.getModel("amazon-bedrock", id)?.cost).toEqual(cost);
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
