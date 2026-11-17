import type {
  AdapterContext,
  AdapterDescriptor,
  SpeechClip,
  VoiceCapabilities,
  VoiceInfo,
  VoiceProvider,
  VoiceSynthesizeRequest,
  VoiceTranscribeRequest,
  VoiceUsage,
  VoiceVerifyResult,
} from "@rakazo/adapter-kit";
import { deadlineSignal } from "@rakazo/core";
import {
  readVoiceAudio,
  readVoiceJson,
  requireOk,
  speechUploadName,
  verifyVoiceHttpGet,
  voiceLanguageHint,
  voiceRequestError,
} from "../../../voice/voice-http.js";
import type { VoiceProviderDefinition } from "../../../voice/voice-provider-descriptor.js";

const API = "https://api.openai.com/v1";
const TTS_MODEL = "gpt-4o-mini-tts";
const STT_MODEL = "gpt-4o-mini-transcribe";

export const OPENAI_VOICES: VoiceInfo[] = [
  { id: "alloy", label: "Alloy", description: "Neutral" },
  { id: "ash", label: "Ash", description: "Clear" },
  { id: "ballad", label: "Ballad", description: "Warm" },
  { id: "cedar", label: "Cedar" },
  { id: "coral", label: "Coral", description: "Bright" },
  { id: "echo", label: "Echo", description: "Even" },
  { id: "fable", label: "Fable", description: "Narrative" },
  { id: "marin", label: "Marin" },
  { id: "onyx", label: "Onyx", description: "Deep" },
  { id: "nova", label: "Nova", description: "Energetic" },
  { id: "sage", label: "Sage", description: "Calm" },
  { id: "shimmer", label: "Shimmer", description: "Soft" },
  { id: "verse", label: "Verse", description: "Expressive" },
];

export class OpenAIVoiceProvider implements VoiceProvider {
  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: "openai",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: true },
    };
  }

  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    return verifyVoiceHttpGet({
      url: `${API}/models`,
      headers: { authorization: `Bearer ${apiKey}` },
      signal: context.signal,
      provider: "OpenAI",
    });
  }

  async listVoices(_apiKey: string, _context: AdapterContext): Promise<VoiceInfo[]> {
    return OPENAI_VOICES;
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const signal = deadlineSignal(60_000, request.signal ?? context.signal);
    const res = await fetch(`${API}/audio/speech`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.model || TTS_MODEL,
        voice: request.voiceId,
        input: request.text,
        response_format: "mp3",
      }),
      signal,
    });
    await requireOk(res, "OpenAI", "speaking");
    return {
      ...(res.headers.get("x-request-id")
        ? { providerRequestId: res.headers.get("x-request-id")! }
        : {}),
      bytes: await readVoiceAudio(res, signal),
      mimeType: "audio/mpeg",
      ...(request.model === "tts-1" || request.model === "tts-1-hd"
        ? {
            usage: {
              model: request.model,
              unit: "characters" as const,
              units: Array.from(request.text).length,
            },
          }
        : {}),
    };
  }

  async transcribe(
    request: VoiceTranscribeRequest,
    context: AdapterContext,
  ): Promise<{ text: string; usage?: VoiceUsage; providerRequestId?: string }> {
    const form = new FormData();
    const model = request.model || STT_MODEL;
    form.set("model", model);
    if (model === "whisper-1") form.set("response_format", "verbose_json");
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
    if (!res.ok) throw voiceRequestError(res.status, "OpenAI", "transcribing", body);
    const result = body as {
      text?: unknown;
      duration?: number;
      usage?: {
        type?: string;
        total_tokens?: number;
        seconds?: number;
        input_tokens?: number;
        output_tokens?: number;
        input_token_details?: { audio_tokens?: number; text_tokens?: number };
      };
    } | null;
    const usage = result?.usage;
    const units =
      usage?.type === "tokens" ? usage.total_tokens : (usage?.seconds ?? result?.duration);
    return {
      ...(res.headers.get("x-request-id")
        ? { providerRequestId: res.headers.get("x-request-id")! }
        : {}),
      text: String(result?.text ?? "").trim(),
      ...(typeof units === "number" && Number.isFinite(units) && units >= 0
        ? {
            usage: {
              model,
              unit: usage?.type === "tokens" ? ("tokens" as const) : ("seconds" as const),
              units,
              ...(usage?.input_tokens !== undefined ? { inputTokens: usage.input_tokens } : {}),
              ...(usage?.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
              ...(usage?.input_token_details?.audio_tokens !== undefined
                ? { inputAudioTokens: usage.input_token_details.audio_tokens }
                : {}),
              ...(usage?.input_token_details?.text_tokens !== undefined
                ? { inputTextTokens: usage.input_token_details.text_tokens }
                : {}),
            },
          }
        : {}),
    };
  }
}

export const openaiVoice: VoiceProviderDefinition = {
  deploymentUsageUnit: (operation, model) => {
    if (operation === "synthesize" && (model === "tts-1" || model === "tts-1-hd"))
      return "characters";
    if (operation === "transcribe" && model === "whisper-1") return "seconds";
    return undefined;
  },
  catalog: {
    name: "OpenAI",
    description: "Simple TTS plus Whisper-class transcription. Reuse an OpenAI key.",
    transcribe: true,
  },
  create: () => new OpenAIVoiceProvider(),
};
