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
  readVoiceJson,
  requireOk,
  speechUploadName,
  voiceDeadline,
  voiceHttpError,
} from "./voice-http.js";

const WHISPER_URL = (process.env.RAKAZO_WHISPER_URL ?? "http://127.0.0.1:9000").replace(/\/$/, "");
const KOKORO_URL = (process.env.RAKAZO_KOKORO_URL ?? "http://127.0.0.1:8880").replace(/\/$/, "");
const WHISPER_MODEL = process.env.RAKAZO_WHISPER_MODEL ?? "large-v3-turbo";
const KOKORO_MODEL = process.env.RAKAZO_KOKORO_MODEL ?? "kokoro";

type LocalKeys = { whisper: string; kokoro: string };

function parseKeys(value: string): LocalKeys {
  const trimmed = value.trim();
  try {
    const parsed = JSON.parse(trimmed) as { whisperApiKey?: unknown; kokoroApiKey?: unknown };
    if (typeof parsed.whisperApiKey === "string" && typeof parsed.kokoroApiKey === "string") {
      return { whisper: parsed.whisperApiKey.trim(), kokoro: parsed.kokoroApiKey.trim() };
    }
  } catch {
    // The settings UI uses the simpler two-line format.
  }
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length >= 2) return { whisper: lines[0]!, kokoro: lines[1]! };
  return { whisper: trimmed, kokoro: trimmed };
}

function auth(key: string): Record<string, string> {
  return key ? { authorization: `Bearer ${key}` } : {};
}

export class LocalVoiceProvider implements VoiceProvider {
  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: "local",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: true },
    };
  }

  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    const keys = parseKeys(apiKey);
    if (!keys.whisper || !keys.kokoro) {
      return { ok: false, message: "Enter the Whisper and Kokoro service tokens." };
    }
    try {
      const [whisper, kokoro] = await Promise.all([
        fetch(`${WHISPER_URL}/v1/models`, {
          headers: auth(keys.whisper),
          signal: voiceDeadline(context.signal, 20_000),
        }),
        fetch(`${KOKORO_URL}/v1/models`, {
          headers: auth(keys.kokoro),
          signal: voiceDeadline(context.signal, 20_000),
        }),
      ]);
      if (whisper.ok && kokoro.ok) return { ok: true };
      return {
        ok: false,
        message: !whisper.ok
          ? voiceHttpError(whisper.status, "Whisper", "checking the local service", await readVoiceJson(whisper))
          : voiceHttpError(kokoro.status, "Kokoro", "checking the local service", await readVoiceJson(kokoro)),
      };
    } catch {
      return {
        ok: false,
        message: "Couldn’t reach the local Whisper or Kokoro service. Check that both Docker containers are running.",
      };
    }
  }

  async listVoices(apiKey: string, context: AdapterContext): Promise<VoiceInfo[]> {
    const keys = parseKeys(apiKey);
    const res = await fetch(`${KOKORO_URL}/v1/voices`, {
      headers: auth(keys.kokoro),
      signal: voiceDeadline(context.signal, 20_000),
    });
    const body = await readVoiceJson(res);
    if (!res.ok) throw new Error(voiceHttpError(res.status, "Kokoro", "listing voices", body));
    const voices = Array.isArray((body as { voices?: unknown } | null)?.voices)
      ? (body as { voices: Array<{ id?: unknown; description?: unknown }> }).voices
      : [];
    return voices.flatMap((voice) =>
      typeof voice.id === "string"
        ? [{ id: voice.id, label: voice.id, description: typeof voice.description === "string" ? voice.description : undefined }]
        : [],
    );
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const keys = parseKeys(request.apiKey);
    const res = await fetch(`${KOKORO_URL}/v1/audio/speech`, {
      method: "POST",
      headers: { ...auth(keys.kokoro), "content-type": "application/json" },
      body: JSON.stringify({ model: KOKORO_MODEL, voice: request.voiceId, input: request.text, response_format: "mp3" }),
      signal: voiceDeadline(request.signal ?? context.signal, 60_000),
    });
    await requireOk(res, "Kokoro", "speaking");
    return { bytes: new Uint8Array(await res.arrayBuffer()), mimeType: "audio/mpeg" };
  }

  async transcribe(request: VoiceTranscribeRequest, context: AdapterContext): Promise<{ text: string }> {
    const keys = parseKeys(request.apiKey);
    const form = new FormData();
    form.set("model", WHISPER_MODEL);
    form.set("response_format", "json");
    form.set("file", new Blob([new Uint8Array(request.audio)], { type: request.mimeType || "audio/webm" }), speechUploadName(request.mimeType));
    const res = await fetch(`${WHISPER_URL}/v1/audio/transcriptions`, {
      method: "POST",
      headers: auth(keys.whisper),
      body: form,
      signal: voiceDeadline(request.signal ?? context.signal, 60_000),
    });
    const body = await readVoiceJson(res);
    if (!res.ok) throw new Error(voiceHttpError(res.status, "Whisper", "transcribing", body));
    return { text: String((body as { text?: unknown } | null)?.text ?? "").trim() };
  }
}
