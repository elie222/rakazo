import type {
  AdapterContext,
  AdapterDescriptor,
  SpeechClip,
  VoiceCapabilities,
  VoiceInfo,
  VoiceProvider,
  VoiceSynthesizeRequest,
  VoiceVerifyResult,
} from "@rakazo/adapter-kit";
import {
  assertAllowedOpenAiCompatibleUrl,
  assertHttpsForKeyedOpenAiCompatibleUrl,
  normalizeOpenAiCompatibleBaseUrl,
} from "./openai-compatible-url.js";
import {
  readVoiceAudio,
  readVoiceJson,
  requireOk,
  voiceDeadline,
  voiceHttpError,
  voiceUnreachable,
} from "./voice-http.js";

/** Catalog / credential id for OpenAI-compatible local TTS (distinct from hosted `openai`). */
export const OPENAI_COMPATIBLE_VOICE_PROVIDER_ID = "openai-compatible" as const;

/** Operator-set base URL for Voice (Models OpenAI-compat URL is not reused). */
export const VOICE_OPENAI_COMPAT_BASE_URL_ENV = "RAKAZO_VOICE_OPENAI_COMPAT_BASE_URL";

/** Optional TTS model id when the gateway expects one (default tts-1). */
export const VOICE_OPENAI_COMPAT_TTS_MODEL_ENV = "RAKAZO_VOICE_OPENAI_COMPAT_TTS_MODEL";

/**
 * Default points at a Voice Studio (or similar) on the Docker host.
 * Containers need host.docker.internal (Docker Desktop) or extra_hosts / a LAN IP.
 */
export const DEFAULT_VOICE_OPENAI_COMPAT_BASE_URL = "http://host.docker.internal:3900";

const DEFAULT_TTS_MODEL = "tts-1";

/** Same static set as hosted OpenAI TTS so local gateways that accept those ids work out of the box. */
const COMPAT_VOICES: VoiceInfo[] = [
  { id: "alloy", label: "Alloy", description: "Neutral" },
  { id: "ash", label: "Ash", description: "Clear" },
  { id: "ballad", label: "Ballad", description: "Warm" },
  { id: "coral", label: "Coral", description: "Bright" },
  { id: "echo", label: "Echo", description: "Even" },
  { id: "fable", label: "Fable", description: "Narrative" },
  { id: "onyx", label: "Onyx", description: "Deep" },
  { id: "nova", label: "Nova", description: "Energetic" },
  { id: "sage", label: "Sage", description: "Calm" },
  { id: "shimmer", label: "Shimmer", description: "Soft" },
  { id: "verse", label: "Verse", description: "Expressive" },
];

export function resolveVoiceOpenAiCompatBaseUrl(
  raw: string | undefined = process.env[VOICE_OPENAI_COMPAT_BASE_URL_ENV],
): string {
  const source = (raw ?? "").trim() || DEFAULT_VOICE_OPENAI_COMPAT_BASE_URL;
  return normalizeOpenAiCompatibleBaseUrl(source);
}

function resolveTtsModel(requestModel: string | undefined): string {
  const fromRequest = requestModel?.trim();
  if (fromRequest && /^[A-Za-z0-9._:-]+$/.test(fromRequest)) return fromRequest;
  const fromEnv = process.env[VOICE_OPENAI_COMPAT_TTS_MODEL_ENV]?.trim();
  if (fromEnv && /^[A-Za-z0-9._:-]+$/.test(fromEnv)) return fromEnv;
  return DEFAULT_TTS_MODEL;
}

function speechApiRoot(apiKey: string | undefined | null): string {
  const normalized = resolveVoiceOpenAiCompatBaseUrl();
  const url = assertAllowedOpenAiCompatibleUrl(normalized);
  assertHttpsForKeyedOpenAiCompatibleUrl(url, apiKey);
  return url.toString().replace(/\/+$/, "");
}

/**
 * Speak-only OpenAI-compatible TTS (POST /v1/audio/speech).
 * Base URL comes from RAKAZO_VOICE_OPENAI_COMPAT_BASE_URL; Bearer from Voice settings.
 */
export class OpenAICompatibleVoiceProvider implements VoiceProvider {
  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: OPENAI_COMPATIBLE_VOICE_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: false },
    };
  }

  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    let base: string;
    try {
      base = speechApiRoot(apiKey);
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Invalid voice server URL.",
      };
    }
    // Prefer /models (OpenAI-shaped). TTS-only gateways often 404 that path — still accept the key
    // when the host is reachable and authentication is not rejected.
    try {
      const res = await fetch(`${base}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: voiceDeadline(context.signal, 20_000),
      });
      if (res.ok || res.status === 404 || res.status === 405) return { ok: true };
      return {
        ok: false,
        message: voiceHttpError(
          res.status,
          "OpenAI-compatible voice",
          "checking that key",
          await readVoiceJson(res),
        ),
      };
    } catch {
      return {
        ok: false,
        message: voiceUnreachable("OpenAI-compatible voice"),
      };
    }
  }

  async listVoices(_apiKey: string, _context: AdapterContext): Promise<VoiceInfo[]> {
    return COMPAT_VOICES;
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const base = speechApiRoot(request.apiKey);
    const signal = voiceDeadline(request.signal ?? context.signal, 60_000);
    const res = await fetch(`${base}/audio/speech`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: resolveTtsModel(request.model),
        voice: request.voiceId,
        input: request.text,
        response_format: "mp3",
      }),
      signal,
    });
    await requireOk(res, "OpenAI-compatible voice", "speaking");
    return { bytes: await readVoiceAudio(res, signal), mimeType: "audio/mpeg" };
  }
}
