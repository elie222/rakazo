import { describe, expect, it } from "vitest";
import { openAiCompatibleConnectReady } from "./openai-compatible-ui.js";

describe("openAiCompatibleConnectReady", () => {
  it("requires a successful probe for new connections", () => {
    expect(
      openAiCompatibleConnectReady({
        baseUrl: "http://127.0.0.1:8000/v1",
        modelId: "qwen",
        probedBaseUrl: "http://127.0.0.1:8000/v1",
      }),
    ).toBe(true);
    expect(
      openAiCompatibleConnectReady({
        baseUrl: "http://127.0.0.1:8000/v1",
        modelId: "qwen",
        probedBaseUrl: null,
      }),
    ).toBe(false);
  });

  it("allows a manual model after a successful probe with no listed models", () => {
    expect(
      openAiCompatibleConnectReady({
        baseUrl: "http://127.0.0.1:8000/v1",
        modelId: "qwen",
        probedBaseUrl: "http://127.0.0.1:8000/v1",
      }),
    ).toBe(true);
  });

  it("allows reconnecting when the stored endpoint is unchanged", () => {
    expect(
      openAiCompatibleConnectReady({
        baseUrl: "http://127.0.0.1:8000/v1",
        modelId: "qwen",
        probedBaseUrl: null,
        storedBaseUrl: "http://127.0.0.1:8000/v1",
      }),
    ).toBe(true);
  });
});
