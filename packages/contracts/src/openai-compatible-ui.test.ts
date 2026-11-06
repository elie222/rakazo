import { describe, expect, it } from "vitest";
import {
  compatibleConnectionName,
  DEEPINFRA_BASE_URL,
  isDeepInfraBaseUrl,
  isOllamaCloudBaseUrl,
  normalizeOpenAiCompatibleBaseUrl,
  OLLAMA_CLOUD_BASE_URL,
  openAiCompatibleConnectReady,
  openAiCompatibleKeyRequired,
  openAiCompatiblePresetFor,
  savedCompatibleEndpointMatches,
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

  it("keeps gateway paths that already contain a version segment", () => {
    expect(normalizeOpenAiCompatibleBaseUrl("https://gateway.example.test/v1/some-model")).toBe(
      "https://gateway.example.test/v1/some-model",
    );
    expect(normalizeOpenAiCompatibleBaseUrl("https://gateway.example.test/v1beta/openai/")).toBe(
      "https://gateway.example.test/v1beta/openai",
    );
    expect(normalizeOpenAiCompatibleBaseUrl("https://gateway.example.test/openai")).toBe(
      "https://gateway.example.test/openai/v1",
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

it.each([
  "https://ollama.com",
  "https://ollama.com/",
  "https://ollama.com/v1/",
  " HTTPS://OLLAMA.COM:443/?q=x ",
])("recognizes normalized Ollama URL %s", (url) => {
  expect(isOllamaCloudBaseUrl(url)).toBe(true);
});
it.each([
  undefined,
  "invalid",
  "https://ollama.com.evil.test",
  "https://ollama.com/v2",
  "http://ollama.com",
  "https://user:pass@ollama.com",
])("rejects non-preset URL %s", (url) => {
  expect(isOllamaCloudBaseUrl(url)).toBe(false);
});

it.each(["https://ollama.com", "https://ollama.com/v1/"])(
  "matches equivalent saved endpoints: %s",
  (baseUrl) => {
    expect(savedCompatibleEndpointMatches(baseUrl, OLLAMA_CLOUD_BASE_URL)).toBe(true);
  },
);
it.each(["", "https://", "https://other.test", "https://ollama.com/v2"])(
  "does not inherit credentials for %s",
  (baseUrl) => {
    expect(savedCompatibleEndpointMatches(baseUrl, OLLAMA_CLOUD_BASE_URL)).toBe(false);
  },
);
it("does not match a missing saved endpoint", () => {
  expect(savedCompatibleEndpointMatches(OLLAMA_CLOUD_BASE_URL, undefined)).toBe(false);
});

describe("hosted OpenAI-compatible presets", () => {
  it("recognizes DeepInfra's OpenAI-compatible base URL and keeps its /v1/openai path", () => {
    expect(normalizeOpenAiCompatibleBaseUrl("https://api.deepinfra.com/v1/openai/")).toBe(
      DEEPINFRA_BASE_URL,
    );
    expect(isDeepInfraBaseUrl("https://api.deepinfra.com/v1/openai")).toBe(true);
    expect(isDeepInfraBaseUrl("https://api.deepinfra.com/v1")).toBe(false);
    expect(openAiCompatiblePresetFor(DEEPINFRA_BASE_URL)?.id).toBe("deepinfra");
    expect(openAiCompatiblePresetFor(OLLAMA_CLOUD_BASE_URL)?.id).toBe("ollama-cloud");
    expect(openAiCompatiblePresetFor("http://127.0.0.1:8000/v1")).toBeUndefined();
  });

  it("names preset connections and requires a key only for presets", () => {
    expect(compatibleConnectionName(DEEPINFRA_BASE_URL, "Custom")).toBe("DeepInfra");
    expect(compatibleConnectionName("http://127.0.0.1:8000/v1", "Custom")).toBe("Custom");
    expect(openAiCompatibleKeyRequired(DEEPINFRA_BASE_URL)).toBe(true);
    expect(openAiCompatibleKeyRequired("http://127.0.0.1:8000/v1")).toBe(false);
    expect(
      openAiCompatibleConnectReady({ baseUrl: DEEPINFRA_BASE_URL, modelId: "zai-org/GLM-4.7" }),
    ).toBe(false);
    expect(
      openAiCompatibleConnectReady({
        baseUrl: DEEPINFRA_BASE_URL,
        modelId: "zai-org/GLM-4.7",
        apiKey: "key",
      }),
    ).toBe(true);
  });
});
