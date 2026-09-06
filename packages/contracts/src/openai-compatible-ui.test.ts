import { describe, expect, it } from "vitest";
import {
  openAiCompatibleConnectReady,
  openAiCompatibleProbeSuccessMessage,
} from "./openai-compatible-ui.js";

describe("openAiCompatibleConnectReady", () => {
  it("allows a new connection with base URL and explicit model id without a probe", () => {
    expect(
      openAiCompatibleConnectReady({
        baseUrl: "http://127.0.0.1:8000/v1",
        modelId: "qwen",
        probedBaseUrl: null,
      }),
    ).toBe(true);
    expect(
      openAiCompatibleConnectReady({
        baseUrl: "http://127.0.0.1:8000/v1",
        modelId: "qwen",
        probedBaseUrl: "http://127.0.0.1:8000/v1",
      }),
    ).toBe(true);
  });

  it("rejects empty base URL or model id", () => {
    expect(
      openAiCompatibleConnectReady({
        baseUrl: "  ",
        modelId: "qwen",
        probedBaseUrl: null,
      }),
    ).toBe(false);
    expect(
      openAiCompatibleConnectReady({
        baseUrl: "http://127.0.0.1:8000/v1",
        modelId: "",
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
