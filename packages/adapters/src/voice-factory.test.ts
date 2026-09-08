import { afterEach, describe, expect, it, vi } from "vitest";
import { CartesiaVoiceProvider } from "./cartesia-voice.js";
import { ElevenLabsVoiceProvider } from "./elevenlabs-voice.js";
import { FishAudioVoiceProvider } from "./fish-audio-voice.js";
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
import { MAX_SYNTHESIZED_AUDIO_BYTES } from "./voice-http.js";

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
  vi.unstubAllEnvs();
  if (previousRuntime === undefined) delete process.env.AGENT_RUNTIME;
  else process.env.AGENT_RUNTIME = previousRuntime;
});

describe("createVoiceProvider", () => {
  it("exposes the hosted catalog behind one factory", () => {
    process.env.AGENT_RUNTIME = "pi";
    expect(VOICE_CATALOG.map((entry) => entry.id)).toEqual([
      "elevenlabs",
      "openai",
      "cartesia",
      "fish-audio",
    ]);
    expect(listVoiceCatalog().map((entry) => entry.id)).toEqual([
      "elevenlabs",
      "openai",
      "cartesia",
      "fish-audio",
    ]);
    expect(createVoiceProvider("elevenlabs").describe().id).toBe("elevenlabs");
    expect(createVoiceProvider("openai").describe().capabilities.transcribe).toBe(true);
    expect(createVoiceProvider("cartesia").describe().capabilities.transcribe).toBe(false);
    expect(createVoiceProvider("fish-audio").describe().capabilities.transcribe).toBe(true);
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
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "hello there" }))),
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
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "hello" })));
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
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [{ id: "sonic", name: "Katie" }] })),
        ),
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

describe("FishAudioVoiceProvider", () => {
  it("lists own then public voice models without duplicates", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ _id: "public-id", title: "Public Voice", languages: ["en", "fr"] }],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              { _id: "private-id", title: "Private Voice", description: "My clone" },
              { _id: "public-id", title: "Duplicate" },
              { _id: "failed-id", title: "Failed", state: "failed" },
            ],
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const voices = await new FishAudioVoiceProvider().listVoices("sk-test", ctx);

    expect(voices).toEqual([
      { id: "private-id", label: "Private Voice", description: "My clone" },
      { id: "public-id", label: "Duplicate" },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("page_size=100");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("self=true");
  });

  it("pages through Fish Audio model listings until has_more is false", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page_number") ?? "1");
      const own = url.searchParams.get("self") === "true";
      const prefix = own ? "own" : "pub";
      return new Response(
        JSON.stringify({
          total: 2,
          has_more: page < 2,
          items: [{ _id: `${prefix}-${page}`, title: `${own ? "Own" : "Public"} ${page}` }],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const voices = await new FishAudioVoiceProvider().listVoices("sk-test", ctx);

    expect(voices.map((voice) => voice.id)).toEqual(["own-1", "own-2", "pub-1", "pub-2"]);
    expect(voices.some((voice) => voice.label === "Public 2")).toBe(true);
    expect(voices.some((voice) => voice.label === "Own 2")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(
      fetchMock.mock.calls
        .map((call) => String(call[0]))
        .filter((url) => url.includes("page_number=2")),
    ).toHaveLength(2);
  });

  it("keeps paging when total implies more pages without has_more", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page_number") ?? "1");
      const own = url.searchParams.get("self") === "true";
      if (own) {
        return new Response(
          JSON.stringify({ total: 1, items: [{ _id: "own-only", title: "Own" }] }),
        );
      }
      return new Response(
        JSON.stringify({
          total: 101,
          items:
            page === 1
              ? Array.from({ length: 100 }, (_, index) => ({
                  _id: `pub-${index + 1}`,
                  title: `Public ${index + 1}`,
                }))
              : [{ _id: "pub-101", title: "Public 101" }],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const voices = await new FishAudioVoiceProvider().listVoices("sk-test", ctx);

    expect(voices.some((voice) => voice.id === "pub-101")).toBe(true);
    expect(voices.some((voice) => voice.label === "Public 101")).toBe(true);
    expect(
      fetchMock.mock.calls.some(
        (call) =>
          String(call[0]).includes("page_number=2") && !String(call[0]).includes("self=true"),
      ),
    ).toBe(true);
  });

  it("stops catalog crawls at page caps when has_more stays true", async () => {
    const publicPages = 5;
    const ownPages = 20;
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page_number") ?? "1");
      const own = url.searchParams.get("self") === "true";
      const prefix = own ? "own" : "pub";
      const start = (page - 1) * 100;
      return new Response(
        JSON.stringify({
          total: 1_000_000,
          has_more: true,
          items: Array.from({ length: 100 }, (_, index) => ({
            _id: `${prefix}-${start + index + 1}`,
            title: `${own ? "Own" : "Public"} ${start + index + 1}`,
          })),
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const voices = await new FishAudioVoiceProvider().listVoices("sk-test", ctx);

    expect(voices).toHaveLength(ownPages * 100 + publicPages * 100);
    expect(voices[0]?.id).toBe("own-1");
    expect(voices.at(ownPages * 100)?.id).toBe("pub-1");
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).includes("self=true")),
    ).toHaveLength(ownPages);
    expect(
      fetchMock.mock.calls.filter((call) => !String(call[0]).includes("self=true")),
    ).toHaveLength(publicPages);
  });

  it("synthesizes with the Fish Audio TTS contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([7, 8]).buffer,
    });
    vi.stubGlobal("fetch", fetchMock);

    const clip = await new FishAudioVoiceProvider().synthesize(
      { text: "Hi", voiceId: "voice-id", apiKey: "sk-test" },
      ctx,
    );

    expect(clip.mimeType).toBe("audio/mpeg");
    expect([...clip.bytes]).toEqual([7, 8]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.fish.audio/v1/tts");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).model).toBe("s2.1-pro");
    expect(JSON.parse(String(init.body))).toMatchObject({
      text: "Hi",
      reference_id: "voice-id",
      format: "mp3",
    });
  });

  it("transcribes through Fish Audio ASR", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "hello" })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new FishAudioVoiceProvider().transcribe!(
        { audio: new Uint8Array([1]), mimeType: "audio/ogg;codecs=opus", apiKey: "sk-test" },
        ctx,
      ),
    ).resolves.toEqual({ text: "hello" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.fish.audio/v1/asr");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const form = init.body as FormData;
    expect((form.get("audio") as File).name).toBe("speech.ogg");
    expect(form.get("ignore_timestamps")).toBe("true");
  });
});

describe("hosted voice response limits", () => {
  it.each([
    ["ElevenLabs", () => new ElevenLabsVoiceProvider(), "voice"],
    ["OpenAI", () => new OpenAIVoiceProvider(), "alloy"],
    ["Cartesia", () => new CartesiaVoiceProvider(), "sonic"],
    ["Fish Audio", () => new FishAudioVoiceProvider(), "voice"],
  ])(
    "rejects an oversized %s speech response before buffering it",
    async (_name, create, voiceId) => {
      const cancel = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          headers: new Headers({
            "content-length": String(MAX_SYNTHESIZED_AUDIO_BYTES + 1),
          }),
          body: { cancel },
        }),
      );

      await expect(
        create().synthesize({ text: "Hi", voiceId, apiKey: "sk-test" }, ctx),
      ).rejects.toThrow("Voice response is too large.");
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
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
