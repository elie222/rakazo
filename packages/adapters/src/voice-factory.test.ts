import { afterEach, describe, expect, it, vi } from "vitest";
import { CartesiaVoiceProvider } from "./cartesia-voice.js";
import { ElevenLabsVoiceProvider } from "./elevenlabs-voice.js";
import { OpenAIVoiceProvider } from "./openai-voice.js";
import {
  SCRIPTED_MPEG,
  SCRIPTED_TRANSCRIPT,
  SCRIPTED_VOICE_ID,
  ScriptedVoiceProvider,
} from "./scripted-voice.js";
import {
  createVoiceProvider,
  isVoiceProviderId,
  listVoiceCatalog,
  VOICE_CATALOG,
} from "./voice-factory.js";

const ctx = {
  operationId: "voice",
  traceId: "voice",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const previousRuntime = process.env.AGENT_RUNTIME;

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousRuntime === undefined) delete process.env.AGENT_RUNTIME;
  else process.env.AGENT_RUNTIME = previousRuntime;
});

describe("createVoiceProvider", () => {
  it("exposes the hosted catalog behind one factory", () => {
    process.env.AGENT_RUNTIME = "pi";
    expect(VOICE_CATALOG.map((entry) => entry.id)).toEqual(["elevenlabs", "openai", "cartesia"]);
    expect(listVoiceCatalog().map((entry) => entry.id)).toEqual([
      "elevenlabs",
      "openai",
      "cartesia",
    ]);
    expect(createVoiceProvider("elevenlabs").describe().id).toBe("elevenlabs");
    expect(createVoiceProvider("openai").describe().capabilities.transcribe).toBe(true);
    expect(createVoiceProvider("cartesia").describe().capabilities.transcribe).toBe(false);
    expect(isVoiceProviderId("elevenlabs")).toBe(true);
    expect(isVoiceProviderId("scripted")).toBe(false);
    expect(isVoiceProviderId("piper")).toBe(false);
    expect(() => createVoiceProvider("piper")).toThrow(/unknown voice provider/i);
    expect(() => createVoiceProvider("scripted")).toThrow(/unknown voice provider/i);
  });

  it("adds the scripted fixture only when the agent runtime is scripted", () => {
    process.env.AGENT_RUNTIME = "scripted";
    expect(listVoiceCatalog().some((entry) => entry.id === "scripted")).toBe(true);
    expect(isVoiceProviderId("scripted")).toBe(true);
    expect(createVoiceProvider("scripted").describe().id).toBe("scripted");
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

  it("transcribes through Scribe", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: "hello there" }),
      }),
    );
    const provider = new ElevenLabsVoiceProvider();
    await expect(
      provider.transcribe!(
        { audio: new Uint8Array([1]), mimeType: "audio/webm", apiKey: "sk" },
        ctx,
      ),
    ).resolves.toEqual({ text: "hello there" });
  });
});

describe("OpenAIVoiceProvider", () => {
  it("returns a static voice catalog without a network round trip", async () => {
    const provider = new OpenAIVoiceProvider();
    const voices = await provider.listVoices("sk-test", ctx);
    expect(voices.some((voice) => voice.id === "alloy")).toBe(true);
  });

  it("posts speech to /audio/speech", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([9]).buffer,
    });
    vi.stubGlobal("fetch", fetchMock);
    const clip = await new OpenAIVoiceProvider().synthesize(
      { text: "Hi", voiceId: "alloy", apiKey: "sk-test" },
      ctx,
    );
    expect(clip.mimeType).toBe("audio/mpeg");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/audio/speech");
  });

  it("names Firefox ogg recordings from the mime type", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: "hello" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await new OpenAIVoiceProvider().transcribe!(
      { audio: new Uint8Array([1]), mimeType: "audio/ogg;codecs=opus", apiKey: "sk-test" },
      ctx,
    );
    const form = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    const file = form.get("file") as File;
    expect(file.name).toBe("speech.ogg");
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

  it("posts bytes to /tts/bytes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([4, 5]).buffer,
    });
    vi.stubGlobal("fetch", fetchMock);
    const clip = await new CartesiaVoiceProvider().synthesize(
      { text: "Hi", voiceId: "sonic", apiKey: "sk-test" },
      ctx,
    );
    expect([...clip.bytes]).toEqual([4, 5]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/tts/bytes");
  });
});

describe("ScriptedVoiceProvider", () => {
  it("verifies, lists, speaks, and transcribes without a network", async () => {
    const provider = new ScriptedVoiceProvider();
    await expect(provider.verify("short", ctx)).resolves.toEqual({
      ok: false,
      message: "That key is too short.",
    });
    await expect(provider.verify("fake-scripted-voice-key", ctx)).resolves.toEqual({ ok: true });
    expect(await provider.listVoices("fake-scripted-voice-key", ctx)).toEqual([
      { id: SCRIPTED_VOICE_ID, label: "Scripted", description: "Test voice" },
    ]);
    const clip = await provider.synthesize(
      { text: "Hello", voiceId: SCRIPTED_VOICE_ID, apiKey: "fake-scripted-voice-key" },
      ctx,
    );
    expect(clip.mimeType).toBe("audio/mpeg");
    expect([...clip.bytes]).toEqual([...SCRIPTED_MPEG]);
    await expect(
      provider.transcribe(
        {
          audio: new Uint8Array([1]),
          mimeType: "audio/webm",
          apiKey: "fake-scripted-voice-key",
        },
        ctx,
      ),
    ).resolves.toEqual({ text: SCRIPTED_TRANSCRIPT });
  });
});
