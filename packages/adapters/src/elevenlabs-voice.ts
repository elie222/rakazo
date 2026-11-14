import type {
  AdapterContext,
  AdapterDescriptor,
  SpeechClip,
  VoiceCapabilities,
  VoiceInfo,
  VoiceProvider,
  VoiceSynthesizeRequest,
  VoiceTranscribeRequest,
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
} from "./voice-http.js";

const API = "https://api.elevenlabs.io/v1";
const MODEL = "eleven_flash_v2_5";
const FORMAT = "mp3_44100_64";
const TRANSCRIBE_MODEL = "scribe_v2";

export class ElevenLabsVoiceProvider implements VoiceProvider {
  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: "elevenlabs",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: true },
    };
  }

  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    return verifyVoiceHttpGet({
      url: `${API}/voices`,
      headers: { "xi-api-key": apiKey },
      signal: context.signal,
      provider: "ElevenLabs",
    });
  }

  async listVoices(apiKey: string, context: AdapterContext): Promise<VoiceInfo[]> {
    const res = await fetch(`${API}/voices`, {
      headers: { "xi-api-key": apiKey },
      signal: deadlineSignal(20_000, context.signal),
    });
    const body = await readVoiceJson(res, { requireValid: res.ok });
    if (!res.ok) throw voiceRequestError(res.status, "ElevenLabs", "listing voices", body);
    const voices = (body as { voices?: Array<Record<string, unknown>> } | null)?.voices ?? [];
    return voices
      .map((voice) => ({
        id: String(voice.voice_id ?? ""),
        label: String(voice.name ?? "Voice"),
        description:
          [asLabel(voice.labels, "accent"), asLabel(voice.labels, "description")]
            .filter(Boolean)
            .join(" · ") || undefined,
      }))
      .filter((voice) => voice.id);
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const signal = deadlineSignal(60_000, request.signal ?? context.signal);
    const res = await fetch(
      `${API}/text-to-speech/${encodeURIComponent(request.voiceId)}?output_format=${FORMAT}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": request.apiKey,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({ text: request.text, model_id: request.model?.trim() || MODEL }),
        signal,
      },
    );
    await requireOk(res, "ElevenLabs", "speaking");
    return { bytes: await readVoiceAudio(res, signal), mimeType: "audio/mpeg" };
  }

  async transcribe(
    request: VoiceTranscribeRequest,
    context: AdapterContext,
  ): Promise<{ text: string }> {
    const form = new FormData();
    form.set("model_id", TRANSCRIBE_MODEL);
    // Without a hint Scribe guesses the language, and a short clip in one language can
    // come back as lookalike words in another.
    const language = voiceLanguageHint(request.language);
    if (language) form.set("language_code", language);
    form.set(
      "file",
      new Blob([new Uint8Array(request.audio)], { type: request.mimeType || "audio/webm" }),
      speechUploadName(request.mimeType),
    );
    const res = await fetch(`${API}/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": request.apiKey },
      body: form,
      signal: deadlineSignal(60_000, request.signal ?? context.signal),
    });
    const body = await readVoiceJson(res, { requireValid: res.ok });
    if (!res.ok) throw voiceRequestError(res.status, "ElevenLabs", "transcribing", body);
    const text = String((body as { text?: unknown } | null)?.text ?? "").trim();
    return { text };
  }
}

function asLabel(labels: unknown, key: string): string {
  if (!labels || typeof labels !== "object") return "";
  const value = (labels as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}
