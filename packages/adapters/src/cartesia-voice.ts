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
  readVoiceAudio,
  readVoiceJson,
  requireOk,
  voiceDeadline,
  voiceHttpError,
} from "./voice-http.js";

const API = "https://api.cartesia.ai";
const VERSION = "2024-06-10";
const MODEL = "sonic-3";

export class CartesiaVoiceProvider implements VoiceProvider {
  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: "cartesia",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: false },
    };
  }

  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    try {
      const res = await fetch(`${API}/voices`, {
        headers: cartesiaHeaders(apiKey),
        signal: voiceDeadline(context.signal, 20_000),
      });
      if (res.ok) return { ok: true };
      return {
        ok: false,
        message: voiceHttpError(
          res.status,
          "Cartesia",
          "checking that key",
          await readVoiceJson(res),
        ),
      };
    } catch {
      return {
        ok: false,
        message: "Couldn't reach Cartesia to check that key — check your connection.",
      };
    }
  }

  async listVoices(apiKey: string, context: AdapterContext): Promise<VoiceInfo[]> {
    const res = await fetch(`${API}/voices`, {
      headers: cartesiaHeaders(apiKey),
      signal: voiceDeadline(context.signal, 20_000),
    });
    const body = await readVoiceJson(res, { requireValid: res.ok });
    if (!res.ok) throw new Error(voiceHttpError(res.status, "Cartesia", "listing voices", body));
    const voices = voicesFrom(body);
    return voices
      .map((voice) => ({
        id: String(voice.id ?? voice.voice_id ?? ""),
        label: String(voice.name ?? "Voice"),
        description: typeof voice.description === "string" ? voice.description : undefined,
      }))
      .filter((voice) => voice.id);
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const signal = voiceDeadline(request.signal ?? context.signal, 60_000);
    const res = await fetch(`${API}/tts/bytes`, {
      method: "POST",
      headers: {
        ...cartesiaHeaders(request.apiKey),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model_id: MODEL,
        transcript: request.text,
        voice: { mode: "id", id: request.voiceId },
        output_format: { container: "mp3", encoding: "mp3", sample_rate: 44100 },
      }),
      signal,
    });
    await requireOk(res, "Cartesia", "speaking");
    return { bytes: await readVoiceAudio(res, signal), mimeType: "audio/mpeg" };
  }
}

function cartesiaHeaders(apiKey: string): Record<string, string> {
  return { "X-API-Key": apiKey, "Cartesia-Version": VERSION };
}

function voicesFrom(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body as Array<Record<string, unknown>>;
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data as Array<Record<string, unknown>>;
    if (Array.isArray(record.voices)) return record.voices as Array<Record<string, unknown>>;
  }
  return [];
}
