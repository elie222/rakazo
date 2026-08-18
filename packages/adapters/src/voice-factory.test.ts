import { afterEach, describe, expect, it, vi } from "vitest";
import { CartesiaVoiceProvider } from "./cartesia-voice.js";
import { ElevenLabsVoiceProvider } from "./elevenlabs-voice.js";
import { OpenAIVoiceProvider } from "./openai-voice.js";
import { createVoiceProvider, isVoiceProviderId, VOICE_CATALOG } from "./voice-factory.js";

const ctx = {
  operationId: "voice",
  traceId: "voice",
  workspaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createVoiceProvider", () => {
  it("exposes the hosted catalog behind one factory", () => {
    expect(VOICE_CATALOG.map((entry) => entry.id)).toEqual(["elevenlabs", "openai", "cartesia"]);
    expect(createVoiceProvider("elevenlabs").describe().id).toBe("elevenlabs");
    expect(createVoiceProvider("openai").describe().capabilities.transcribe).toBe(true);
    expect(createVoiceProvider("cartesia").describe().capabilities.transcribe).toBe(false);
    expect(isVoiceProviderId("elevenlabs")).toBe(true);
    expect(isVoiceProviderId("piper")).toBe(false);
    expect(() => createVoiceProvider("piper")).toThrow(/unknown voice provider/i);
  });
});

describe("ElevenLabsVoiceProvider", () => {
  it("verifies against /voices so restricted speech keys still pass", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ voices: [{ voice_id: "abc", name: "Rachel" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ElevenLabsVoiceProvider();
    await expect(provider.verify("sk_test_key", ctx)).resolves.toEqual({ ok: true });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/voices");
  });

  it("synthesizes one utterance as mp3 bytes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ElevenLabsVoiceProvider();
    const clip = await provider.synthesize(
      { text: "Hello there.", voiceId: "abc", apiKey: "sk_test_key" },
      ctx,
    );
    expect(clip.mimeType).toBe("audio/mpeg");
    expect([...clip.bytes]).toEqual([1, 2, 3]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/text-to-speech/abc");
  });
});

describe("OpenAIVoiceProvider", () => {
  it("returns a static voice catalog without a network round trip", async () => {
    const provider = new OpenAIVoiceProvider();
    const voices = await provider.listVoices("sk-test", ctx);
    expect(voices.some((voice) => voice.id === "alloy")).toBe(true);
  });
});

describe("CartesiaVoiceProvider", () => {
  it("maps the voices list from either array or { data } payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "sonic", name: "Katie" }] }),
      }),
    );
    const provider = new CartesiaVoiceProvider();
    const voices = await provider.listVoices("sk-test", ctx);
    expect(voices).toEqual([{ id: "sonic", label: "Katie", description: undefined }]);
  });
});
