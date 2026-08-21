import { describe, expect, it } from "vitest";
import {
  GATEWAY_PROVIDER_PREFIX,
  isGatewayProvider,
  normalizeOpenAICompatibleBaseUrl,
  parseAvailableModels,
  serializeAvailableModels,
} from "./openai-compatible.js";

describe("openai-compatible gateways", () => {
  it("normalizes hostnames, trailing slashes, and missing protocols", () => {
    expect(normalizeOpenAICompatibleBaseUrl("localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(normalizeOpenAICompatibleBaseUrl("https://api.example.com/v1/")).toBe(
      "https://api.example.com/v1",
    );
  });

  it("rejects non-http URLs", () => {
    expect(() => normalizeOpenAICompatibleBaseUrl("ftp://example.com")).toThrow(/http/);
  });

  it("round-trips model lists and recognizes gateway provider ids", () => {
    expect(parseAvailableModels("gpt-4o\nllama3, mistral")).toEqual(["gpt-4o", "llama3", "mistral"]);
    expect(serializeAvailableModels(["gpt-4o", "gpt-4o", "llama3"])).toBe("gpt-4o\nllama3");
    expect(isGatewayProvider(`${GATEWAY_PROVIDER_PREFIX}abc`)).toBe(true);
    expect(isGatewayProvider("openai-compatible")).toBe(true);
    expect(isGatewayProvider("openrouter")).toBe(false);
  });
});
