import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterVoiceProvider, openRouterVoice } from "./openrouter-voice.js";

const context: AdapterContext = {
  operationId: "test-operation",
  traceId: "test-trace",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(...responses: Array<() => Response>) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const next = responses.length > 1 ? responses.shift()! : responses[0]!;
    return next();
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const body = (fetch: ReturnType<typeof stubFetch>, call = 0) =>
  JSON.parse(String(fetch.mock.calls[call]![1]?.body));

const MODELS = {
  data: [
    {
      id: "mistralai/voxtral-mini-tts-2603",
      name: "Mistral: Voxtral",
      supported_voices: ["en_paul"],
    },
    {
      id: "openai/gpt-4o-mini-tts-2025-12-15",
      name: "OpenAI: GPT-4o Mini TTS",
      supported_voices: ["alloy", "nova", 7],
    },
    { id: "fish/s2", supported_voices: [] },
    { name: "No id" },
  ],
};

describe("OpenRouterVoiceProvider", () => {
  it("lists speech models by name", async () => {
    const fetch = stubFetch(() => Response.json(MODELS));
    const models = await new OpenRouterVoiceProvider().listModels("key", context);
    expect(models).toEqual([
      { id: "fish/s2", label: "fish/s2" },
      { id: "mistralai/voxtral-mini-tts-2603", label: "Mistral: Voxtral" },
      { id: "openai/gpt-4o-mini-tts-2025-12-15", label: "OpenAI: GPT-4o Mini TTS" },
    ]);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://openrouter.ai/api/v1/models?output_modalities=speech");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer key");
  });

  it("lists the voices of the chosen model, or of the default one", async () => {
    stubFetch(() => Response.json(MODELS));
    const provider = new OpenRouterVoiceProvider();
    expect(
      await provider.listVoices("key", context, { model: "openai/gpt-4o-mini-tts-2025-12-15" }),
    ).toEqual([
      { id: "alloy", label: "alloy" },
      { id: "nova", label: "nova" },
    ]);
    expect((await provider.listVoices("key", context)).map((voice) => voice.id)).toEqual([
      "en_paul",
    ]);
    expect(await provider.listVoices("key", context, { model: "fish/s2" })).toEqual([]);
    expect(await provider.listVoices("key", context, { model: "unknown/model" })).toEqual([]);
  });

  it("asks for MP3 and returns it as is", async () => {
    const fetch = stubFetch(
      () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }),
    );
    const clip = await new OpenRouterVoiceProvider().synthesize(
      { text: "Hi", voiceId: "alloy", apiKey: "key", model: "openai/gpt-4o-mini-tts-2025-12-15" },
      context,
    );
    expect(clip).toMatchObject({ bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/mpeg" });
    expect(clip.usage).toBeUndefined();
    expect(String(fetch.mock.calls[0]![0])).toBe("https://openrouter.ai/api/v1/audio/speech");
    expect(body(fetch)).toEqual({
      model: "openai/gpt-4o-mini-tts-2025-12-15",
      voice: "alloy",
      input: "Hi",
      response_format: "mp3",
    });
  });

  it("falls back to raw samples for a model that refuses MP3 and wraps them as WAV", async () => {
    const fetch = stubFetch(
      () =>
        Response.json(
          { error: { message: "mp3 is not supported by this model" } },
          { status: 400 },
        ),
      () =>
        new Response(new Uint8Array([1, 0, 2, 0]), {
          headers: { "content-type": "audio/pcm;rate=24000;channels=1" },
        }),
    );
    const clip = await new OpenRouterVoiceProvider().synthesize(
      { text: "Hi", voiceId: "v", apiKey: "key", model: "google/gemini-tts" },
      context,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(body(fetch, 1).response_format).toBe("pcm");
    expect(clip.mimeType).toBe("audio/wav");
    expect(String.fromCharCode(...clip.bytes.subarray(0, 4))).toBe("RIFF");
    expect(new DataView(clip.bytes.buffer).getUint32(24, true)).toBe(24000);
    expect([...clip.bytes.subarray(44)]).toEqual([1, 0, 2, 0]);
  });

  it("does not retry a 400 that is not about the format", async () => {
    const fetch = stubFetch(() =>
      Response.json({ error: { message: "Unknown voice 'zzz'" } }, { status: 400 }),
    );
    await expect(
      new OpenRouterVoiceProvider().synthesize(
        { text: "Hi", voiceId: "zzz", apiKey: "key" },
        context,
      ),
    ).rejects.toThrow("Unknown voice 'zzz'");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts the audio/mp3 label for MP3 audio", async () => {
    stubFetch(
      () => new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mp3" } }),
    );
    const clip = await new OpenRouterVoiceProvider().synthesize(
      { text: "Hi", voiceId: "v", apiKey: "key" },
      context,
    );
    expect(clip.mimeType).toBe("audio/mpeg");
  });

  it("refuses raw samples that do not name their rate", async () => {
    stubFetch(
      () => new Response(new Uint8Array([1, 0]), { headers: { "content-type": "audio/pcm" } }),
    );
    await expect(
      new OpenRouterVoiceProvider().synthesize(
        { text: "Hi", voiceId: "v", apiKey: "key" },
        context,
      ),
    ).rejects.toThrow("did not say how its audio is encoded");
  });

  it("refuses audio it cannot play", async () => {
    stubFetch(
      () => new Response(new Uint8Array([1]), { headers: { "content-type": "audio/flac" } }),
    );
    await expect(
      new OpenRouterVoiceProvider().synthesize(
        { text: "Hi", voiceId: "v", apiKey: "key" },
        context,
      ),
    ).rejects.toThrow("can't be played");
  });

  it("transcribes with the default model and reports seconds when given", async () => {
    const fetch = stubFetch(() =>
      Response.json({ text: " hello ", usage: { seconds: 2.5, cost: 0.01 } }),
    );
    const result = await new OpenRouterVoiceProvider().transcribe(
      { audio: new Uint8Array([1]), mimeType: "audio/webm", apiKey: "key", language: "en-US" },
      context,
    );
    expect(result).toEqual({
      text: "hello",
      usage: { model: "openai/whisper-large-v3", unit: "seconds", units: 2.5 },
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    const form = init?.body as FormData;
    expect(form.get("model")).toBe("openai/whisper-large-v3");
    expect(form.get("language")).toBe("en");
    expect((form.get("file") as File).name).toBe("speech.webm");
  });

  it("reports no usage when none comes back", async () => {
    stubFetch(() => Response.json({ text: "hi" }));
    const result = await new OpenRouterVoiceProvider().transcribe(
      { audio: new Uint8Array([1]), mimeType: "audio/webm", apiKey: "key" },
      context,
    );
    expect(result).toEqual({ text: "hi" });
  });

  it("checks the key against the key endpoint", async () => {
    const fetch = stubFetch(() => new Response("{}", { status: 401 }));
    const result = await new OpenRouterVoiceProvider().verify("bad", context);
    expect(result.ok).toBe(false);
    expect(String(fetch.mock.calls[0]![0])).toBe("https://openrouter.ai/api/v1/key");
  });

  it("can use the account's Models connection and meters seconds-billed transcription", () => {
    expect(openRouterVoice.catalog).toMatchObject({ modelConnection: true, speechModels: true });
    expect(openRouterVoice.transcriptionUsageUnit?.("x-ai/grok-stt-2.0")).toBe("seconds");
    expect(openRouterVoice.transcriptionUsageUnit?.("openai/gpt-4o-transcribe")).toBeUndefined();
  });
});
