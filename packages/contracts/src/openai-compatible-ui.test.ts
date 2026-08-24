import { describe, expect, it } from "vitest";
import {
  openAiCompatibleConnectReady,
  openAiCompatibleProbeSuccessMessage,
} from "./openai-compatible-ui.js";

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

  it("guides manual entry when a successful probe lists no models", () => {
    expect(openAiCompatibleProbeSuccessMessage(0)).toBe("Server found. Enter a model name.");
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
