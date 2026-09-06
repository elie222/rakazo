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
import {
  readVoiceAudio,
  readVoiceJson,
  requireOk,
  speechUploadName,
  voiceDeadline,
  voiceHttpError,
} from "./voice-http.js";

const API = "https://api.elevenlabs.io/v1";
const MODEL = "eleven_flash_v2_5";
const FORMAT = "mp3_44100_64";
const TRANSCRIBE_MODEL = "scribe_v1";

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
    try {
      const res = await fetch(`${API}/voices`, {
        headers: { "xi-api-key": apiKey },
        signal: voiceDeadline(context.signal, 20_000),
      });
      if (res.ok) return { ok: true };
      return {
        ok: false,
        message: voiceHttpError(
          res.status,
          "ElevenLabs",
          "checking that key",
          await readVoiceJson(res),
        ),
      };
    } catch {
      return {
        ok: false,
        message: "Couldn't reach ElevenLabs to check that key — check your connection.",
      };
    }
  }

  async listVoices(apiKey: string, context: AdapterContext): Promise<VoiceInfo[]> {
    const res = await fetch(`${API}/voices`, {
      headers: { "xi-api-key": apiKey },
      signal: voiceDeadline(context.signal, 20_000),
    });
    const body = await readVoiceJson(res, { requireValid: res.ok });
    if (!res.ok) throw new Error(voiceHttpError(res.status, "ElevenLabs", "listing voices", body));
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
    const signal = voiceDeadline(request.signal ?? context.signal, 60_000);
    const res = await fetch(
      `${API}/text-to-speech/${encodeURIComponent(request.voiceId)}?output_format=${FORMAT}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": request.apiKey,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({ text: request.text, model_id: MODEL }),
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
    form.set(
      "file",
      new Blob([new Uint8Array(request.audio)], { type: request.mimeType || "audio/webm" }),
      speechUploadName(request.mimeType),
    );
    const res = await fetch(`${API}/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": request.apiKey },
      body: form,
      signal: voiceDeadline(request.signal ?? context.signal, 60_000),
    });
    const body = await readVoiceJson(res, { requireValid: res.ok });
    if (!res.ok) throw new Error(voiceHttpError(res.status, "ElevenLabs", "transcribing", body));
    const text = String((body as { text?: unknown } | null)?.text ?? "").trim();
    return { text };
  }
}

function asLabel(labels: unknown, key: string): string {
  if (!labels || typeof labels !== "object") return "";
  const value = (labels as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}
