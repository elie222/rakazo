import { describe, expect, it } from "vitest";
import type { OpenAiCompatiblePreset } from "./domain.js";
import {
  compatibleConnectionName,
  connectedPresetBaseUrls,
  normalizeOpenAiCompatibleBaseUrl,
  openAiCompatibleConnectReady,
  openAiCompatibleKeyRequired,
  openAiCompatiblePresetFor,
  savedCompatibleEndpointMatches,
} from "./openai-compatible-ui.js";

const HOSTED = "https://hosted.example.test/v1";
const NESTED = "https://api.nested.example.test/v1/openai";
const presets: OpenAiCompatiblePreset[] = [
  { id: "hosted", name: "Hosted Example", baseUrl: HOSTED, keyRequired: true },
  { id: "nested", name: "Nested Example", baseUrl: NESTED, keyRequired: true },
  { id: "open", name: "Open Example", baseUrl: "https://open.example.test/v1", keyRequired: false },
];

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

describe("hosted OpenAI-compatible presets", () => {
  it.each([
    "https://hosted.example.test",
    "https://hosted.example.test/",
    "https://hosted.example.test/v1/",
    " HTTPS://HOSTED.EXAMPLE.TEST:443/?q=x ",
  ])("recognizes the preset at normalized URL %s", (url) => {
    expect(openAiCompatiblePresetFor(presets, url)?.id).toBe("hosted");
  });

  it.each([
    undefined,
    "invalid",
    "https://hosted.example.test.evil.test",
    "https://hosted.example.test/v2",
    "http://hosted.example.test",
    "https://user:pass@hosted.example.test",
  ])("does not mistake %s for a preset", (url) => {
    expect(openAiCompatiblePresetFor(presets, url)).toBeUndefined();
  });

  it("keeps a preset path that already holds a version segment", () => {
    expect(normalizeOpenAiCompatibleBaseUrl("https://api.nested.example.test/v1/openai/")).toBe(
      NESTED,
    );
    expect(openAiCompatiblePresetFor(presets, `${NESTED}/`)?.id).toBe("nested");
    expect(openAiCompatiblePresetFor(presets, "https://api.nested.example.test/v1")).toBe(
      undefined,
    );
  });

  it("recognizes nothing without a preset list", () => {
    expect(openAiCompatiblePresetFor([], HOSTED)).toBeUndefined();
    expect(compatibleConnectionName([], HOSTED, "Custom")).toBe("Custom");
    expect(openAiCompatibleKeyRequired([], HOSTED)).toBe(false);
  });

  it("names preset connections from the list it is given", () => {
    expect(compatibleConnectionName(presets, HOSTED, "Custom")).toBe("Hosted Example");
    expect(compatibleConnectionName(presets, "http://127.0.0.1:8000/v1", "Custom")).toBe("Custom");
  });

  it("requires a key only where the preset says so", () => {
    expect(openAiCompatibleKeyRequired(presets, HOSTED)).toBe(true);
    expect(openAiCompatibleKeyRequired(presets, "https://open.example.test")).toBe(false);
    expect(openAiCompatibleKeyRequired(presets, "http://127.0.0.1:8000/v1")).toBe(false);
  });

  it("waits for a key when the endpoint needs one", () => {
    const input = { baseUrl: HOSTED, modelId: "example-model", keyRequired: true };
    expect(openAiCompatibleConnectReady(input)).toBe(false);
    expect(openAiCompatibleConnectReady({ ...input, apiKey: " " })).toBe(false);
    expect(openAiCompatibleConnectReady({ ...input, apiKey: "fake-key" })).toBe(true);
  });

  it("lists every preset with a saved connection, however many share the provider", () => {
    expect(
      connectedPresetBaseUrls(presets, [
        { provider: "openai-compatible", baseUrl: `${HOSTED}/` },
        { provider: "openai-compatible", baseUrl: NESTED },
        { provider: "openai-compatible", baseUrl: "http://127.0.0.1:8000/v1" },
        { provider: "openai-compatible" },
        { provider: "anthropic", baseUrl: "https://open.example.test/v1" },
      ]),
    ).toEqual(new Set([HOSTED, NESTED]));
  });
});

it.each(["https://hosted.example.test", "https://hosted.example.test/v1/"])(
  "matches equivalent saved endpoints: %s",
  (baseUrl) => {
    expect(savedCompatibleEndpointMatches(baseUrl, HOSTED)).toBe(true);
  },
);
it.each(["", "https://", "https://other.test", "https://hosted.example.test/v2"])(
  "does not inherit credentials for %s",
  (baseUrl) => {
    expect(savedCompatibleEndpointMatches(baseUrl, HOSTED)).toBe(false);
  },
);
it("does not match a missing saved endpoint", () => {
  expect(savedCompatibleEndpointMatches(HOSTED, undefined)).toBe(false);
});
