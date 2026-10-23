import { describe, expect, it } from "vitest";
import {
  compatibleConnectionName,
  normalizeOpenAiCompatibleBaseUrl,
  OLLAMA_CLOUD_BASE_URL,
  openAiCompatibleConnectReady,
} from "./openai-compatible-ui.js";

describe("openAiCompatibleConnectReady", () => {
  it("allows a new connection with base URL and explicit model id", () => {
    expect(
      openAiCompatibleConnectReady({
        baseUrl: "http://127.0.0.1:8000/v1",
        modelId: "qwen",
      }),
    ).toBe(true);
  });

  it("rejects empty base URL or model id", () => {
    expect(
      openAiCompatibleConnectReady({
        baseUrl: "  ",
        modelId: "qwen",
      }),
    ).toBe(false);
    expect(
      openAiCompatibleConnectReady({
        baseUrl: "http://127.0.0.1:8000/v1",
        modelId: "",
      }),
    ).toBe(false);
  });
});

describe("normalizeOpenAiCompatibleBaseUrl", () => {
  it("drops trailing slashes and adds /v1 only when no version is present", () => {
    expect(normalizeOpenAiCompatibleBaseUrl(" http://127.0.0.1:8000/ ")).toBe(
      "http://127.0.0.1:8000/v1",
    );
    expect(normalizeOpenAiCompatibleBaseUrl("https://open.bigmodel.cn/api/paas/v4/")).toBe(
      "https://open.bigmodel.cn/api/paas/v4",
    );
  });

  it("rejects text that is not an HTTP(S) URL", () => {
    expect(() => normalizeOpenAiCompatibleBaseUrl("127.0.0.1:8000")).toThrow();
  });
});

it("uses an ordinary compatible connection for the Ollama preset and requires its key", () => {
  expect(OLLAMA_CLOUD_BASE_URL).toBe("https://ollama.com/v1");
  expect(compatibleConnectionName(OLLAMA_CLOUD_BASE_URL, "OpenAI-compatible")).toBe("Ollama Cloud");
  expect(compatibleConnectionName("https://other.test/v1", "OpenAI-compatible")).toBe(
    "OpenAI-compatible",
  );
  const input = { baseUrl: OLLAMA_CLOUD_BASE_URL, modelId: "example-model" };
  expect(openAiCompatibleConnectReady(input)).toBe(false);
  expect(openAiCompatibleConnectReady({ ...input, apiKey: "fake-key" })).toBe(true);
});
