import { describe, expect, it } from "vitest";
import {
  COMMANDCODE_BASE_URL,
  compatibleEndpointPresets,
  isCommandCodeBaseUrl,
  isOpenCodeGoBaseUrl,
  matchCompatibleEndpointPreset,
  normalizeOpenAiCompatibleBaseUrl,
  OPENCODE_GO_BASE_URL,
  openAiCompatibleConnectReady,
  savedCompatibleEndpointMatches,
} from "./openai-compatible-ui.js";

const PRESET_BASE_URL = "https://hosted.example.test/v1";
const presets = [{ name: "Hosted", baseUrl: PRESET_BASE_URL }];

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

it("requires a key only when the endpoint needs one", () => {
  const input = { baseUrl: PRESET_BASE_URL, modelId: "example-model" };
  expect(openAiCompatibleConnectReady(input)).toBe(true);
  expect(openAiCompatibleConnectReady({ ...input, keyRequired: true })).toBe(false);
  expect(openAiCompatibleConnectReady({ ...input, keyRequired: true, apiKey: "fake-key" })).toBe(
    true,
  );
});

it("collects the presets the catalog offers", () => {
  expect(compatibleEndpointPresets([{}, { endpointPresets: presets }])).toEqual(presets);
  // Several compatible entries carry the same presets; each address is offered once.
  expect(
    compatibleEndpointPresets([{ endpointPresets: presets }, { endpointPresets: presets }]),
  ).toEqual(presets);
});

it.each([
  "https://hosted.example.test",
  "https://hosted.example.test/",
  "https://hosted.example.test/v1/",
  " HTTPS://HOSTED.EXAMPLE.TEST:443/?q=x ",
])("matches the normalized preset URL %s", (url) => {
  expect(matchCompatibleEndpointPreset(presets, url)?.name).toBe("Hosted");
});
it.each([
  undefined,
  "invalid",
  "https://hosted.example.test.evil.test",
  "https://hosted.example.test/v2",
  "http://hosted.example.test",
  "https://user:pass@hosted.example.test",
])("matches no preset for %s", (url) => {
  expect(matchCompatibleEndpointPreset(presets, url)).toBeUndefined();
});

it.each(["https://hosted.example.test", "https://hosted.example.test/v1/"])(
  "matches equivalent saved endpoints: %s",
  (baseUrl) => {
    expect(savedCompatibleEndpointMatches(baseUrl, PRESET_BASE_URL)).toBe(true);
  },
);
it.each(["", "https://", "https://other.test", "https://hosted.example.test/v2"])(
  "does not inherit credentials for %s",
  (baseUrl) => {
    expect(savedCompatibleEndpointMatches(baseUrl, PRESET_BASE_URL)).toBe(false);
  },
);
it("does not match a missing saved endpoint", () => {
  expect(savedCompatibleEndpointMatches(PRESET_BASE_URL, undefined)).toBe(false);
});

it("recognizes manual CommandCode endpoints and requires a key through its preset", () => {
  expect(COMMANDCODE_BASE_URL).toBe("https://api.commandcode.ai/provider/v1");
  const commandCode = [{ name: "CommandCode", baseUrl: COMMANDCODE_BASE_URL }];
  expect(matchCompatibleEndpointPreset(commandCode, `${COMMANDCODE_BASE_URL}/`)?.name).toBe(
    "CommandCode",
  );
  // Typed addresses normalize before matching, so the key is required for an equivalent URL.
  expect(
    matchCompatibleEndpointPreset(commandCode, "https://api.commandcode.ai/provider")?.name,
  ).toBe("CommandCode");
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
  expect(isOpenCodeGoBaseUrl(OPENCODE_GO_BASE_URL)).toBe(true);
  expect(isOpenCodeGoBaseUrl(`${OPENCODE_GO_BASE_URL}/`)).toBe(true);
  expect(isOpenCodeGoBaseUrl("https://opencode.ai.evil.test/zen/go/v1")).toBe(false);
  expect(isOpenCodeGoBaseUrl("http://opencode.ai/zen/go/v1")).toBe(false);
});
