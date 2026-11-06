import { OPENAI_COMPATIBLE_PRESETS } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { presetKeyPlaceholder, presetName, probedModelPrefill } from "./openai-compatible-presets";

const t = (message: string) => `[${message}]`;

describe("presetName and presetKeyPlaceholder", () => {
  it("labels every hosted preset, so a new one cannot be added without strings", () => {
    expect(OPENAI_COMPATIBLE_PRESETS.map((preset) => presetName(preset, t))).toEqual([
      "[Ollama Cloud]",
      "[DeepInfra]",
    ]);
    expect(OPENAI_COMPATIBLE_PRESETS.map((preset) => presetKeyPlaceholder(preset, t))).toEqual([
      "[Ollama API key]",
      "[DeepInfra API key]",
    ]);
  });
});

describe("probedModelPrefill", () => {
  const cacheCapabilities = { scope: "account", retentionMode: "short" } as const;
  const details = [
    {
      id: "vision",
      supportsImages: true,
      reasoning: true,
      contextWindow: 131072,
      cacheCapabilities,
    },
    { id: "plain", supportsImages: false, reasoning: false },
    { id: "unknown" },
  ];

  it("returns every capability the listing gave, with the context limit as form text", () => {
    expect(probedModelPrefill(details, "vision")).toEqual({
      supportsImages: true,
      reasoning: true,
      contextWindow: "131072",
      cacheCapabilities,
    });
  });

  it("keeps an explicit false, since absent (unknown) and false (unsupported) differ", () => {
    expect(probedModelPrefill(details, "plain")).toEqual({
      supportsImages: false,
      reasoning: false,
    });
  });

  it("returns nothing for a model with no facts or one the listing never mentioned", () => {
    expect(probedModelPrefill(details, "unknown")).toEqual({});
    expect(probedModelPrefill(details, "missing")).toEqual({});
    expect(probedModelPrefill([], "vision")).toEqual({});
  });
});
