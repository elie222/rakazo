import { describe, expect, it } from "vitest";
import { modelMark } from "./model-marks.js";

describe("modelMark", () => {
  it("names the maker from the id prefix, then the catalog label, then the provider", () => {
    const claude = modelMark({ provider: "anthropic" });
    expect(claude).toBeDefined();
    expect(modelMark({ provider: "router", modelId: "anthropic/claude-x" })).toBe(claude);
    expect(modelMark({ provider: "router", modelLabel: "Anthropic: Claude X" })).toBe(claude);
    expect(modelMark({ provider: "openai-codex" })).toBe(modelMark({ provider: "openai" }));
    expect(modelMark({ provider: "router", modelId: "meta-llama/llama-x" })).toBe(
      modelMark({ provider: "meta" }),
    );
  });

  it("has no mark for a maker it does not know", () => {
    expect(modelMark({ provider: "my-server", modelId: "local-model" })).toBeUndefined();
  });
});
