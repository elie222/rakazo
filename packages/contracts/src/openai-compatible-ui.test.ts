import { describe, expect, it } from "vitest";
import {
  COMMANDCODE_BASE_URL,
  compatibleConnectionName,
  isCommandCodeBaseUrl,
  isOllamaCloudBaseUrl,
  isOpenCodeGoBaseUrl,
  normalizeOpenAiCompatibleBaseUrl,
  OLLAMA_CLOUD_BASE_URL,
  OPENCODE_GO_BASE_URL,
  openAiCompatibleConnectReady,
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

  it("keeps gateway paths that contain a version segment", () => {
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

it("recognizes manual CommandCode endpoints and requires the same key as its preset", () => {
  expect(COMMANDCODE_BASE_URL).toBe("https://api.commandcode.ai/provider/v1");
  expect(compatibleConnectionName(COMMANDCODE_BASE_URL, "OpenAI-compatible")).toBe("CommandCode");
  const input = { baseUrl: COMMANDCODE_BASE_URL, modelId: "example-model" };
  expect(openAiCompatibleConnectReady(input)).toBe(false);
  expect(openAiCompatibleConnectReady({ ...input, apiKey: "fake-key" })).toBe(true);
  expect(isCommandCodeBaseUrl(`${COMMANDCODE_BASE_URL}/`)).toBe(true);
  for (const url of [
    undefined,
    "https://api.commandcode.ai.evil.test/provider/v1",
    "http://api.commandcode.ai/provider/v1",
    `${COMMANDCODE_BASE_URL}?key=other`,
  ])
    expect(isCommandCodeBaseUrl(url)).toBe(false);
});

it("recognizes direct OpenCode Go URLs without requiring its dedicated picker", () => {
  expect(compatibleConnectionName(OPENCODE_GO_BASE_URL, "OpenAI-compatible")).toBe("OpenCode Go");
  expect(
    openAiCompatibleConnectReady({ baseUrl: OPENCODE_GO_BASE_URL, modelId: "example-model" }),
  ).toBe(false);
  expect(isOpenCodeGoBaseUrl(`${OPENCODE_GO_BASE_URL}/`)).toBe(true);
  expect(isOpenCodeGoBaseUrl("https://opencode.ai.evil.test/zen/go/v1")).toBe(false);
  expect(isOpenCodeGoBaseUrl("http://opencode.ai/zen/go/v1")).toBe(false);
});
