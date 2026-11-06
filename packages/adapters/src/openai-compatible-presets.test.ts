import { OpenAiCompatiblePresetSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  DEEPINFRA_BASE_URL,
  hostedPresetFor,
  isDeepInfraBaseUrl,
  OLLAMA_CLOUD_BASE_URL,
  OPENAI_COMPATIBLE_PRESETS,
} from "./openai-compatible-presets.js";
import { assertAllowedOpenAiCompatibleUrl } from "./openai-compatible-url.js";

describe("hosted OpenAI-compatible presets", () => {
  it("lists presets in the shape the apps receive, each reachable at its own address", () => {
    expect(
      OPENAI_COMPATIBLE_PRESETS.map((preset) => OpenAiCompatiblePresetSchema.parse(preset)),
    ).toEqual(OPENAI_COMPATIBLE_PRESETS);
    expect(new Set(OPENAI_COMPATIBLE_PRESETS.map((preset) => preset.baseUrl)).size).toBe(
      OPENAI_COMPATIBLE_PRESETS.length,
    );
    expect(OPENAI_COMPATIBLE_PRESETS.every((preset) => preset.keyRequired)).toBe(true);
  });

  it("keeps the base URLs the connections are saved under", () => {
    expect(OLLAMA_CLOUD_BASE_URL).toBe("https://ollama.com/v1");
    expect(DEEPINFRA_BASE_URL).toBe("https://api.deepinfra.com/v1/openai");
    expect(OPENAI_COMPATIBLE_PRESETS.map((preset) => [preset.id, preset.name])).toEqual([
      ["ollama-cloud", "Ollama Cloud"],
      ["deepinfra", "DeepInfra"],
    ]);
  });

  it.each([
    ["https://ollama.com", "ollama-cloud"],
    ["https://ollama.com/v1/", "ollama-cloud"],
    [" HTTPS://OLLAMA.COM:443/?q=x ", "ollama-cloud"],
    ["https://api.deepinfra.com/v1/openai/", "deepinfra"],
  ])("recognizes %s as %s", (url, id) => {
    expect(hostedPresetFor(url)?.id).toBe(id);
  });

  it.each([
    undefined,
    "invalid",
    "https://ollama.com.evil.test",
    "https://ollama.com/v2",
    "http://ollama.com",
    "https://user:pass@ollama.com",
    "https://api.deepinfra.com/v1",
    "http://127.0.0.1:8000/v1",
  ])("does not mistake %s for a preset", (url) => {
    expect(hostedPresetFor(url)).toBeUndefined();
  });

  it("tells DeepInfra's endpoint from the other presets", () => {
    expect(isDeepInfraBaseUrl("https://api.deepinfra.com/v1/openai")).toBe(true);
    expect(isDeepInfraBaseUrl("https://api.deepinfra.com/v1")).toBe(false);
    expect(isDeepInfraBaseUrl(OLLAMA_CLOUD_BASE_URL)).toBe(false);
  });

  it("keeps every preset host reachable when public hosts are off", () => {
    for (const preset of OPENAI_COMPATIBLE_PRESETS)
      expect(assertAllowedOpenAiCompatibleUrl(preset.baseUrl, { allowPublic: false }).href).toBe(
        preset.baseUrl,
      );
    expect(() =>
      assertAllowedOpenAiCompatibleUrl("https://models.example.test/v1", { allowPublic: false }),
    ).toThrow("Public model endpoints are disabled");
  });
});
