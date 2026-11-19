import type {
  AdapterContext,
  AdapterDescriptor,
  SpeechClip,
  VoiceCapabilities,
  VoiceInfo,
  VoiceModelInfo,
  VoiceProvider,
  VoiceSynthesizeRequest,
  VoiceTranscribeRequest,
  VoiceUsage,
  VoiceVerifyResult,
} from "@rakazo/adapter-kit";
import { deadlineSignal } from "@rakazo/core";
import { parsePcmContentType, pcmToWav } from "../../../voice/pcm-wav.js";
import {
  readVoiceAudio,
  readVoiceJson,
  speechUploadName,
  verifyVoiceHttpGet,
  voiceErrorDetail,
  voiceLanguageHint,
  voiceRequestError,
} from "../../../voice/voice-http.js";
import type { VoiceProviderDefinition } from "../../../voice/voice-provider-descriptor.js";

export const OPENROUTER_VOICE_PROVIDER_ID = "openrouter";
const API = "https://openrouter.ai/api/v1";
const PROVIDER = "OpenRouter";
const TTS_MODEL = "mistralai/voxtral-mini-tts-2603";
const STT_MODEL = "openai/whisper-large-v3";
const MAX_LISTED_MODELS = 500;
const FORMAT_REFUSAL = /\b(?:mp3|mpeg|pcm|format)\b/i;

type SpeechModel = VoiceModelInfo & { voices: string[] };

function modelRequestError(status: number, what: string, body: unknown): Error {
  return voiceRequestError(status, PROVIDER, what, body);
}

/** Every speech model OpenRouter lists, with the voices each one accepts. */
async function fetchSpeechModels(apiKey: string, signal: AbortSignal): Promise<SpeechModel[]> {
  const res = await fetch(`${API}/models?output_modalities=speech`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: deadlineSignal(20_000, signal),
  });
  if (!res.ok) throw modelRequestError(res.status, "listing models", await readVoiceJson(res));
  const body = await readVoiceJson(res, { requireValid: true });
  const listed = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(listed)) return [];
  const models: SpeechModel[] = [];
  for (const entry of listed.slice(0, MAX_LISTED_MODELS)) {
    if (!entry || typeof entry !== "object") continue;
    const { id, name, supported_voices: voices } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id) continue;
    models.push({
      id,
      label: typeof name === "string" && name.trim() ? name.trim() : id,
      voices: Array.isArray(voices)
        ? voices.filter((voice): voice is string => typeof voice === "string" && voice !== "")
        : [],
    });
  }
  return models;
}

/** Speech and transcription through OpenRouter's OpenAI-shaped audio endpoints. */
export class OpenRouterVoiceProvider implements VoiceProvider {
  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: OPENROUTER_VOICE_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: true },
    };
  }

  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    return verifyVoiceHttpGet({
      url: `${API}/key`,
      headers: { authorization: `Bearer ${apiKey}` },
      signal: context.signal,
      provider: PROVIDER,
    });
  }

  async listModels(apiKey: string, context: AdapterContext): Promise<VoiceModelInfo[]> {
    const models = await fetchSpeechModels(apiKey, context.signal);
    return models
      .map(({ id, label }) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  async listVoices(
    apiKey: string,
    context: AdapterContext,
    options: { model?: string } = {},
  ): Promise<VoiceInfo[]> {
    const model = options.model || TTS_MODEL;
    const models = await fetchSpeechModels(apiKey, context.signal);
    const voices = models.find((entry) => entry.id === model)?.voices ?? [];
    return voices.map((id) => ({ id, label: id }));
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const signal = deadlineSignal(60_000, request.signal ?? context.signal);
    const speak = (format: "mp3" | "pcm") =>
      fetch(`${API}/audio/speech`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${request.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: request.model || TTS_MODEL,
          voice: request.voiceId,
          input: request.text,
          response_format: format,
        }),
        signal,
      });
    let res = await speak("mp3");
    if (res.status === 400) {
      // Some models return only raw samples and refuse MP3; any other 400 is the caller's to fix.
      const refusal = await readVoiceJson(res);
      if (!FORMAT_REFUSAL.test(voiceErrorDetail(refusal))) {
        throw modelRequestError(res.status, "speaking", refusal);
      }
      res = await speak("pcm");
      if (!res.ok) throw modelRequestError(res.status, "speaking", await readVoiceJson(res));
    } else if (!res.ok) {
      throw modelRequestError(res.status, "speaking", await readVoiceJson(res));
    }
    const providerRequestId =
      res.headers.get("x-generation-id") ?? res.headers.get("x-request-id") ?? undefined;
    const contentType = res.headers.get("content-type");
    const bytes = await readVoiceAudio(res, signal);
    const mime = contentType?.split(";")[0]?.trim().toLowerCase();
    if (mime === "audio/pcm") {
      const format = parsePcmContentType(contentType);
      if (!format) throw new Error("This speech model did not say how its audio is encoded.");
      return {
        ...(providerRequestId ? { providerRequestId } : {}),
        bytes: pcmToWav(bytes, format),
        mimeType: "audio/wav",
      };
    }
    if (mime !== "audio/mpeg" && mime !== "audio/mp3")
      throw new Error("This speech model returned audio that can't be played.");
    return {
      ...(providerRequestId ? { providerRequestId } : {}),
      bytes,
      mimeType: "audio/mpeg",
    };
  }

  async transcribe(
    request: VoiceTranscribeRequest,
    context: AdapterContext,
  ): Promise<{ text: string; usage?: VoiceUsage; providerRequestId?: string }> {
    const form = new FormData();
    const model = request.model || STT_MODEL;
    form.set("model", model);
    const language = voiceLanguageHint(request.language);
    if (language?.length === 2) form.set("language", language);
    form.set(
      "file",
      new Blob([new Uint8Array(request.audio)], { type: request.mimeType || "audio/webm" }),
      speechUploadName(request.mimeType),
    );
    const res = await fetch(`${API}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${request.apiKey}` },
      body: form,
      signal: deadlineSignal(60_000, request.signal ?? context.signal),
    });
    const body = await readVoiceJson(res, { requireValid: res.ok });
    if (!res.ok) throw modelRequestError(res.status, "transcribing", body);
    const result = body as { text?: unknown; usage?: { seconds?: unknown } } | null;
    const seconds = result?.usage?.seconds;
    const providerRequestId = res.headers.get("x-generation-id") ?? undefined;
    return {
      ...(providerRequestId ? { providerRequestId } : {}),
      text: String(result?.text ?? "").trim(),
      ...(typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
        ? { usage: { model, unit: "seconds" as const, units: seconds } }
        : {}),
    };
  }
}

export const openRouterVoice: VoiceProviderDefinition = {
  catalog: {
    name: "OpenRouter",
    description: "Speech and transcription from many providers, with one key.",
    transcribe: true,
    speechModel: true,
    speechModels: true,
    freeformVoice: true,
    modelConnection: true,
  },
  create: () => new OpenRouterVoiceProvider(),
};
