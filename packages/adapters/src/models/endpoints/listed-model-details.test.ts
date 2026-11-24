import { describe, expect, it } from "vitest";
import { listedModelDetails } from "./listed-model-details.js";

describe("listedModelDetails", () => {
  it("reads capabilities and token limits from an Anthropic-style list", () => {
    expect(
      listedModelDetails({
        id: "fixture",
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
        capabilities: { image_input: { supported: false }, thinking: { supported: true } },
      }),
    ).toEqual({ contextWindow: 1_000_000, maxTokens: 128_000, images: false, reasoning: true });
  });

  it("reads modalities and parameters from an OpenRouter-style list", () => {
    expect(
      listedModelDetails({
        id: "fixture",
        context_length: 200_000,
        top_provider: { max_completion_tokens: 64_000 },
        architecture: { input_modalities: ["text", "image"] },
        supported_parameters: ["tools"],
      }),
    ).toEqual({ contextWindow: 200_000, maxTokens: 64_000, images: true, reasoning: false });
  });

  it("keeps the context window when the output limit leaves no room for input", () => {
    expect(
      listedModelDetails({
        max_input_tokens: 8_000,
        max_tokens: 8_000,
        capabilities: { image_input: { supported: true } },
      }),
    ).toEqual({ contextWindow: 8_000, images: true });
  });
});
