import { writeFile } from "node:fs/promises";
import type { VoiceProvider } from "@rakazo/adapter-kit";
import { VoiceCatalogEntrySchema } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CartesiaVoiceProvider } from "./cartesia-voice.js";
import { ElevenLabsVoiceProvider } from "./elevenlabs-voice.js";
import { FishAudioVoiceProvider } from "./fish-audio-voice.js";
import type { SayRunner } from "./macos-voice.js";
import { MacOsVoiceProvider } from "./macos-voice.js";
import {
  OpenAiCompatibleVoiceProvider,
  serializeOpenAiCompatibleVoiceSecret,
} from "./openai-compatible-voice.js";
import { OpenAIVoiceProvider } from "./openai-voice.js";
import { ScriptedVoiceProvider } from "./scripted-voice.js";
import type { VoiceProviderId } from "./voice-providers.js";
import { voiceProviders } from "./voice-providers.js";
import { XaiVoiceProvider } from "./xai-voice.js";

const ctx = {
  operationId: "voice",
  traceId: "voice",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const MPEG = Uint8Array.from([0xff, 0xfb, 0x90, 0x00]);
const TRANSCRIPT = "hello from the conformance suite";

const audio = () => new Response(MPEG, { headers: { "content-type": "audio/mpeg" } });
const transcript = () => Response.json({ text: TRANSCRIPT });

/** Answers by method, origin and path; any other request fails the test, so nothing goes online. */
type Routes = Record<string, () => Response>;

/** An offline provider for the shared suite. */
interface VoiceConformanceFixture {
  provider(fetch: typeof globalThis.fetch): VoiceProvider;
  /** The stored secret the provider reads as its key. */
  apiKey: string;
  routes?: Routes;
}

const SPEECH_SERVER = "http://192.168.1.20:8880/v1";

const sayListing = "Albert              en_US    # Hello! My name is Albert.\n";
const fakeSay: SayRunner = async (args) => {
  if (args[1] === "?") return sayListing;
  const output = args[args.indexOf("-o") + 1];
  if (output) await writeFile(output, MPEG);
  return "";
};

/** Keyed by every provider id, so a provider without an offline fixture fails typecheck. */
const fixtures: Record<VoiceProviderId, VoiceConformanceFixture> = {
  macos: { provider: () => new MacOsVoiceProvider(fakeSay, {}), apiKey: "macos" },
  scripted: { provider: () => new ScriptedVoiceProvider(), apiKey: "test-voice-key" },
  elevenlabs: {
    provider: () => new ElevenLabsVoiceProvider(),
    apiKey: "test-voice-key",
    routes: {
      "GET https://api.elevenlabs.io/v1/voices": () =>
        Response.json({ voices: [{ voice_id: "voice-1", name: "Rachel" }] }),
      "POST https://api.elevenlabs.io/v1/text-to-speech/voice-1": audio,
      "POST https://api.elevenlabs.io/v1/speech-to-text": transcript,
    },
  },
  openai: {
    provider: () => new OpenAIVoiceProvider(),
    apiKey: "test-voice-key",
    routes: {
      "GET https://api.openai.com/v1/models": () => Response.json({ data: [] }),
      "POST https://api.openai.com/v1/audio/speech": audio,
      "POST https://api.openai.com/v1/audio/transcriptions": transcript,
    },
  },
  cartesia: {
    provider: () => new CartesiaVoiceProvider(),
    apiKey: "test-voice-key",
    routes: {
      "GET https://api.cartesia.ai/voices": () =>
        Response.json({ data: [{ id: "voice-1", name: "Katie" }], has_more: false }),
      "POST https://api.cartesia.ai/tts/bytes": audio,
    },
  },
  "fish-audio": {
    provider: () => new FishAudioVoiceProvider(),
    apiKey: "test-voice-key",
    routes: {
      "GET https://api.fish.audio/model": () =>
        Response.json({ items: [{ _id: "voice-1", title: "Narrator" }], total: 1 }),
      "POST https://api.fish.audio/v1/tts": audio,
      "POST https://api.fish.audio/v1/asr": transcript,
    },
  },
  xai: {
    provider: () => new XaiVoiceProvider(),
    apiKey: "test-voice-key",
    routes: {
      "GET https://api.x.ai/v1/tts/voices": () =>
        Response.json({ voices: [{ voice_id: "voice-1", name: "Eve" }] }),
      "POST https://api.x.ai/v1/tts": audio,
      "POST https://api.x.ai/v1/stt": transcript,
    },
  },
  "openai-compatible": {
    provider: (fetch) => new OpenAiCompatibleVoiceProvider({ fetch, allowPrivateEndpoint: true }),
    apiKey: serializeOpenAiCompatibleVoiceSecret(
      { baseUrl: SPEECH_SERVER, ttsModel: "kokoro", sttModel: "whisper-1" },
      undefined,
      { allowPrivate: true },
    ),
    routes: {
      [`GET ${SPEECH_SERVER}/models`]: () => Response.json({ data: [] }),
      [`GET ${SPEECH_SERVER}/audio/voices`]: () => Response.json({ voices: ["af_heart"] }),
      [`POST ${SPEECH_SERVER}/audio/speech`]: audio,
      [`POST ${SPEECH_SERVER}/audio/transcriptions`]: transcript,
    },
  },
};

function serve(routes: Routes = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const request = `${init?.method ?? "GET"} ${url.origin}${url.pathname}`;
    const route = routes[request];
    if (!route) throw new Error(`Unexpected request: ${request}`);
    return route();
  });
}

function setUp(kind: VoiceProviderId, routes = fixtures[kind].routes) {
  const fetch = serve(routes);
  vi.stubGlobal("fetch", fetch);
  // A transport other than the global one, which some adapters replace with their own.
  const injected: typeof globalThis.fetch = (input, init) => fetch(input, init);
  return fixtures[kind].provider(injected);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const kinds = Object.keys(fixtures) as VoiceProviderId[];

describe.each(kinds)("%s voice conformance", (kind) => {
  const definition = voiceProviders[kind];
  const { apiKey } = fixtures[kind];

  it("describes itself as its catalog entry does", () => {
    const provider = setUp(kind);
    const described = provider.describe();
    expect(described.id).toBe(kind);
    expect(VoiceCatalogEntrySchema.safeParse({ id: kind, ...definition.catalog }).success).toBe(
      true,
    );
    expect(described.capabilities.transcribe).toBe(definition.catalog.transcribe);
    expect(typeof provider.transcribe === "function").toBe(definition.catalog.transcribe);
    expect(Boolean(described.capabilities.languages)).toBe(Boolean(definition.catalog.languages));
  });

  it("verifies a key, lists voices and speaks with one of them", async () => {
    const provider = setUp(kind);
    expect(await provider.verify(apiKey, ctx)).toMatchObject({ ok: true });
    const voices = await provider.listVoices(apiKey, ctx);
    expect(voices.length).toBeGreaterThan(0);
    expect(new Set(voices.map((voice) => voice.id)).size).toBe(voices.length);
    for (const voice of voices) {
      expect(voice.id).not.toBe("");
      expect(voice.label).not.toBe("");
    }
    const clip = await provider.synthesize(
      { apiKey, voiceId: voices[0]!.id, text: "Hello there." },
      ctx,
    );
    expect(clip.bytes.byteLength).toBeGreaterThan(0);
    expect(clip.mimeType).toMatch(/^audio\//);
  });

  it.runIf(definition.catalog.transcribe)("transcribes a recording", async () => {
    const provider = setUp(kind);
    const result = await provider.transcribe!(
      { apiKey, audio: MPEG, mimeType: "audio/mpeg", language: "en-US" },
      ctx,
    );
    expect(result.text).not.toBe("");
  });

  it.runIf(fixtures[kind].routes)(
    "reports a rejected key from verify and fails speaking",
    async () => {
      const rejected = Object.fromEntries(
        Object.keys(fixtures[kind].routes!).map((route) => [
          route,
          () => Response.json({ error: { message: "Invalid API key" } }, { status: 401 }),
        ]),
      );
      const provider = setUp(kind, rejected);
      expect(await provider.verify(apiKey, ctx)).toMatchObject({ ok: false });
      await expect(
        provider.synthesize({ apiKey, voiceId: "voice-1", text: "Hello there." }, ctx),
      ).rejects.toThrow();
    },
  );

  it("is what the factory builds for its id", () => {
    expect(definition.create({}).describe().id).toBe(kind);
  });
});
