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

  it("returns the switches and the context limit as form text, leaving cache pricing to the connect request", () => {
    expect(probedModelPrefill(details, "vision", "4096")).toEqual({
      supportsImages: true,
      reasoning: true,
      contextWindow: "131072",
    });
  });

  it("keeps an explicit false, since absent (unknown) and false (unsupported) differ", () => {
    expect(probedModelPrefill(details, "plain", "4096")).toEqual({
      supportsImages: false,
      reasoning: false,
    });
  });

  it("returns nothing for a model with no facts or one the listing never mentioned", () => {
    expect(probedModelPrefill(details, "unknown", "4096")).toEqual({});
    expect(probedModelPrefill(details, "missing", "4096")).toEqual({});
    expect(probedModelPrefill([], "vision", "4096")).toEqual({});
  });

  describe("output limit against the published context limit", () => {
    const contextOf = (contextWindow: number) => [{ id: "m", contextWindow }];

    it.each([
      [4096, "4096", "2048"],
      [8192, "9000", "4096"],
      [2, "4096", "1"],
      [3, "3", "1"],
    ])(
      "lowers the output limit when a %i-token context would not leave it room (was %s)",
      (contextWindow, current, lowered) => {
        expect(probedModelPrefill(contextOf(contextWindow), "m", current)).toEqual({
          contextWindow: String(contextWindow),
          maxTokens: lowered,
        });
      },
    );

    it("keeps an output limit that already fits", () => {
      expect(probedModelPrefill(contextOf(8192), "m", "4096")).toEqual({ contextWindow: "8192" });
    });

    it("leaves an output limit it cannot read to the form's own validation", () => {
      expect(probedModelPrefill(contextOf(8192), "m", "")).toEqual({ contextWindow: "8192" });
      expect(probedModelPrefill(contextOf(8192), "m", "lots")).toEqual({ contextWindow: "8192" });
    });

    it("does not prefill a one-token context, which no output limit can fit under", () => {
      expect(
        probedModelPrefill([{ id: "m", reasoning: true, contextWindow: 1 }], "m", "4096"),
      ).toEqual({
        reasoning: true,
      });
    });
  });
});
