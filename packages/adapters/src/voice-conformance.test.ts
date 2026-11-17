import { writeFile } from "node:fs/promises";
import type { VoiceProvider } from "@rakazo/adapter-kit";
import { VoiceCatalogEntrySchema } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CartesiaVoiceProvider } from "./providers/voice/cartesia/cartesia-voice.js";
import { ElevenLabsVoiceProvider } from "./providers/voice/elevenlabs/elevenlabs-voice.js";
import { FishAudioVoiceProvider } from "./providers/voice/fish-audio/fish-audio-voice.js";
import type { SayRunner } from "./providers/voice/macos/macos-voice.js";
import { MacOsVoiceProvider } from "./providers/voice/macos/macos-voice.js";
import { OpenAIVoiceProvider } from "./providers/voice/openai/openai-voice.js";
import {
  OpenAiCompatibleVoiceProvider,
  serializeOpenAiCompatibleVoiceSecret,
} from "./providers/voice/openai-compatible/openai-compatible-voice.js";
import {
  SCRIPTED_TRANSCRIPT,
  ScriptedVoiceProvider,
} from "./providers/voice/scripted/scripted-voice.js";
import { XaiVoiceProvider } from "./providers/voice/xai/xai-voice.js";
import type { VoiceProviderId } from "./voice-providers.js";
import { voiceProviders } from "./voice-providers.js";

const ctx = {
  operationId: "voice",
  traceId: "voice",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const MPEG = Uint8Array.from([0xff, 0xfb, 0x90, 0x00]);
const TRANSCRIPT = "hello from the conformance suite";

/** A RIFF/WAVE header for 16-bit mono PCM at 22.05 kHz with no samples. */
const WAV = (() => {
  const view = new DataView(new ArrayBuffer(44));
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 22050, true);
  view.setUint32(28, 44100, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, 0, true);
  return new Uint8Array(view.buffer);
})();

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/** Whether the bytes start the way a file of the declared type does. */
const audioSignatures: Record<string, (bytes: Uint8Array) => boolean> = {
  "audio/wav": (bytes) => ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE",
  "audio/mpeg": (bytes) =>
    ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0),
  "audio/ogg": (bytes) => ascii(bytes, 0, 4) === "OggS",
  "audio/flac": (bytes) => ascii(bytes, 0, 4) === "fLaC",
};

function matchesSignature(mimeType: string, bytes: Uint8Array): boolean {
  const base = mimeType.split(";")[0]!.trim().toLowerCase();
  return audioSignatures[base]?.(bytes) ?? false;
}

const audio = () => new Response(MPEG, { headers: { "content-type": "audio/mpeg" } });
const transcript = () => Response.json({ text: TRANSCRIPT });

/** What a real server checks before answering; a request without it gets the server's refusal. */
interface Route {
  answer: () => Response;
  /** Query parameters the endpoint requires. */
  query?: string[];
  /** Fields a JSON body must carry. */
  json?: string[];
  /** Fields a multipart form must carry. */
  form?: string[];
}

/**
 * Keyed by method, origin and path; any other request fails the test, so nothing goes online.
 * A route given as a bare answer only checks the fixture's authentication.
 */
type Routes = Record<string, Route | (() => Response)>;

/** An offline provider for the shared suite. */
interface VoiceConformanceFixture {
  provider(fetch: typeof globalThis.fetch): VoiceProvider;
  /** The stored secret the provider reads as its key. */
  apiKey: string;
  /** Headers every request must carry, as the real server authenticates the fixture key. */
  auth?: Record<string, string>;
  routes?: Routes;
}

const TEST_KEY = "test-voice-key";
const bearer = { authorization: `Bearer ${TEST_KEY}` };

const SPEECH_SERVER = "https://192.0.2.10:8880/v1";

const sayListing = "Albert              en_US    # Hello! My name is Albert.\n";
const fakeSay: SayRunner = async (args) => {
  if (args[1] === "?") return sayListing;
  const output = args[args.indexOf("-o") + 1];
  if (output) await writeFile(output, WAV);
  return "";
};

/** Keyed by every provider id, so a provider without an offline fixture fails typecheck. */
const fixtures: Record<VoiceProviderId, VoiceConformanceFixture> = {
  macos: { provider: () => new MacOsVoiceProvider(fakeSay, {}), apiKey: "macos" },
  scripted: { provider: () => new ScriptedVoiceProvider(), apiKey: TEST_KEY },
  elevenlabs: {
    provider: () => new ElevenLabsVoiceProvider(),
    apiKey: TEST_KEY,
    auth: { "xi-api-key": TEST_KEY },
    routes: {
      "GET https://api.elevenlabs.io/v1/voices": () =>
        Response.json({ voices: [{ voice_id: "voice-1", name: "Rachel" }] }),
      "POST https://api.elevenlabs.io/v1/text-to-speech/voice-1": {
        answer: audio,
        query: ["output_format"],
        json: ["text", "model_id"],
      },
      "POST https://api.elevenlabs.io/v1/speech-to-text": {
        answer: transcript,
        form: ["model_id", "file"],
      },
    },
  },
  openai: {
    provider: () => new OpenAIVoiceProvider(),
    apiKey: TEST_KEY,
    auth: bearer,
    routes: {
      "GET https://api.openai.com/v1/models": () => Response.json({ data: [] }),
      "POST https://api.openai.com/v1/audio/speech": {
        answer: audio,
        json: ["model", "voice", "input"],
      },
      "POST https://api.openai.com/v1/audio/transcriptions": {
        answer: transcript,
        form: ["model", "file"],
      },
    },
  },
  cartesia: {
    provider: () => new CartesiaVoiceProvider(),
    apiKey: TEST_KEY,
    auth: bearer,
    routes: {
      "GET https://api.cartesia.ai/voices": () =>
        Response.json({ data: [{ id: "voice-1", name: "Katie" }], has_more: false }),
      "POST https://api.cartesia.ai/tts/bytes": {
        answer: audio,
        json: ["model_id", "transcript", "voice", "output_format"],
      },
    },
  },
  "fish-audio": {
    provider: () => new FishAudioVoiceProvider(),
    apiKey: TEST_KEY,
    auth: bearer,
    routes: {
      "GET https://api.fish.audio/model": {
        answer: () => Response.json({ items: [{ _id: "voice-1", title: "Narrator" }], total: 1 }),
        query: ["page_size", "page_number"],
      },
      "POST https://api.fish.audio/v1/tts": {
        answer: audio,
        json: ["text", "reference_id", "format"],
      },
      "POST https://api.fish.audio/v1/asr": { answer: transcript, form: ["audio"] },
    },
  },
  xai: {
    provider: () => new XaiVoiceProvider(),
    apiKey: TEST_KEY,
    auth: bearer,
    routes: {
      "GET https://api.x.ai/v1/tts/voices": () =>
        Response.json({ voices: [{ voice_id: "voice-1", name: "Eve" }] }),
      "POST https://api.x.ai/v1/tts": { answer: audio, json: ["text", "voice_id"] },
      "POST https://api.x.ai/v1/stt": { answer: transcript, form: ["file"] },
    },
  },
  "openai-compatible": {
    provider: (fetch) => new OpenAiCompatibleVoiceProvider({ fetch, allowPrivateEndpoint: true }),
    apiKey: serializeOpenAiCompatibleVoiceSecret(
      { baseUrl: SPEECH_SERVER, apiKey: TEST_KEY, ttsModel: "kokoro", sttModel: "whisper-1" },
      undefined,
      { allowPrivate: true },
    ),
    auth: bearer,
    routes: {
      [`GET ${SPEECH_SERVER}/models`]: () => Response.json({ data: [] }),
      [`GET ${SPEECH_SERVER}/audio/voices`]: {
        answer: () => Response.json({ voices: ["af_heart"] }),
        query: ["model"],
      },
      [`POST ${SPEECH_SERVER}/audio/speech`]: {
        answer: audio,
        json: ["model", "voice", "input"],
      },
      [`POST ${SPEECH_SERVER}/audio/transcriptions`]: {
        answer: transcript,
        form: ["model", "file"],
      },
    },
  },
};

const refuse = (status: number, message: string) =>
  Response.json({ error: { message } }, { status });

/** Why a real server would refuse this request, or undefined when it would answer. */
async function refusal(
  request: Request,
  route: Route,
  auth: Record<string, string>,
): Promise<Response | undefined> {
  for (const [name, value] of Object.entries(auth)) {
    if (request.headers.get(name) !== value) return refuse(401, "Invalid API key");
  }
  const params = new URL(request.url).searchParams;
  const missingQuery = route.query?.find((name) => !params.get(name));
  if (missingQuery) return refuse(422, `Missing query parameter ${missingQuery}`);
  if (route.json) {
    if (!request.headers.get("content-type")?.includes("application/json")) {
      return refuse(415, "Expected a JSON body");
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return refuse(400, "Body is not valid JSON");
    }
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const missing = route.json.find((field) => record[field] === undefined || record[field] === "");
    if (missing) return refuse(422, `Missing field ${missing}`);
  }
  if (route.form) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return refuse(400, "Expected a multipart form");
    }
    const missing = route.form.find((field) => !form.has(field));
    if (missing) return refuse(422, `Missing form field ${missing}`);
  }
  return undefined;
}

function serve(routes: Routes = {}, auth: Record<string, string> = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const key = `${request.method} ${url.origin}${url.pathname}`;
    const entry = routes[key];
    if (!entry) throw new Error(`Unexpected request: ${key}`);
    const route = typeof entry === "function" ? { answer: entry } : entry;
    return (await refusal(request, route, auth)) ?? route.answer();
  });
}

function setUp(kind: VoiceProviderId, routes = fixtures[kind].routes) {
  const fetch = serve(routes, fixtures[kind].auth);
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
    // Every provider lists voices and speaks; the tests below call both.
    expect(described.capabilities.catalog).toBe(true);
    expect(described.capabilities.synthesize).toBe(true);
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
    expect(matchesSignature(clip.mimeType, clip.bytes)).toBe(true);
  });

  it.runIf(definition.catalog.transcribe)("transcribes a recording", async () => {
    const provider = setUp(kind);
    const result = await provider.transcribe!(
      { apiKey, audio: MPEG, mimeType: "audio/mpeg", language: "en-US" },
      ctx,
    );
    expect(result.text).toBe(kind === "scripted" ? SCRIPTED_TRANSCRIPT : TRANSCRIPT);
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
