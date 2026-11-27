import type {
  AdapterContext,
  AdapterDescriptor,
  SpeechClip,
  VoiceCapabilities,
  VoiceInfo,
  VoiceModelInfo,
  VoiceProvider,
  VoiceSynthesizeRequest,
  VoiceVerifyResult,
} from "@rakazo/adapter-kit";
import { deadlineSignal } from "@rakazo/core";
import {
  readVoiceAudio,
  readVoiceJson,
  requireOk,
  verifyVoiceHttpGet,
  voiceRequestError,
} from "../../../voice/voice-http.js";
import type { VoiceProviderDefinition } from "../../../voice/voice-provider-descriptor.js";

const API = "https://api.typecast.ai";
const MODEL = "ssfm-v31";
// Typecast asks direct HTTP integrations to name the library and the agent that wrote them.
const USER_AGENT =
  "typecast-direct/1 fetch typecast-integration/1 (source=api-docs; generated_by=amp)";

export class TypecastVoiceProvider implements VoiceProvider {
  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: "typecast",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: false },
    };
  }

  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    return verifyVoiceHttpGet({
      url: `${API}/v1/users/me/subscription`,
      headers: typecastHeaders(apiKey),
      signal: context.signal,
      provider: "Typecast",
    });
  }

  async listVoices(
    apiKey: string,
    context: AdapterContext,
    options: { model?: string } = {},
  ): Promise<VoiceInfo[]> {
    // Voices support only some models, so list the ones the connection's model can speak with.
    const voices = await fetchVoices(apiKey, context, options.model?.trim() || MODEL);
    return voices
      .map((voice) => ({
        id: typeof voice.voice_id === "string" ? voice.voice_id : "",
        label: voiceName(voice.voice_name),
        description:
          [traitLabel(voice.gender), traitLabel(voice.age)].filter(Boolean).join(" · ") ||
          undefined,
      }))
      .filter((voice) => voice.id);
  }

  /** Typecast has no model listing, so the models are the ones its voices say they support. */
  async listModels(apiKey: string, context: AdapterContext): Promise<VoiceModelInfo[]> {
    const versions = new Set<string>();
    for (const voice of await fetchVoices(apiKey, context)) {
      if (!Array.isArray(voice.models)) continue;
      for (const model of voice.models as Array<{ version?: unknown }>) {
        if (typeof model?.version === "string" && model.version) versions.add(model.version);
      }
    }
    return [...versions]
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((id) => ({ id, label: id }));
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const signal = deadlineSignal(60_000, request.signal ?? context.signal);
    const res = await fetch(`${API}/v1/text-to-speech`, {
      method: "POST",
      headers: { ...typecastHeaders(request.apiKey), "content-type": "application/json" },
      body: JSON.stringify({
        voice_id: request.voiceId,
        text: request.text,
        model: request.model?.trim() || MODEL,
        // Smart emotion reads the tone from the text instead of speaking every reply flat.
        prompt: { emotion_type: "smart" },
        output: { audio_format: "mp3" },
      }),
      signal,
    });
    await requireOk(res, "Typecast", "speaking");
    return { bytes: await readVoiceAudio(res, signal), mimeType: "audio/mpeg" };
  }
}

function typecastHeaders(apiKey: string): Record<string, string> {
  return { "X-API-KEY": apiKey, "User-Agent": USER_AGENT };
}

async function fetchVoices(
  apiKey: string,
  context: AdapterContext,
  model?: string,
): Promise<Array<Record<string, unknown>>> {
  const query = model ? `?${new URLSearchParams({ model })}` : "";
  const res = await fetch(`${API}/v3/voices${query}`, {
    headers: typecastHeaders(apiKey),
    signal: deadlineSignal(20_000, context.signal),
  });
  const body = await readVoiceJson(res, { requireValid: res.ok });
  if (!res.ok) throw voiceRequestError(res.status, "Typecast", "listing voices", body);
  return Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [];
}

/** The v3 name is localized; older shapes send a plain string. */
function voiceName(name: unknown): string {
  if (typeof name === "string" && name.trim()) return name.trim();
  if (name && typeof name === "object") {
    const { eng, kor } = name as { eng?: unknown; kor?: unknown };
    if (typeof eng === "string" && eng.trim()) return eng.trim();
    if (typeof kor === "string" && kor.trim()) return kor.trim();
  }
  return "Voice";
}

/** "young_adult" reads as "Young adult". */
function traitLabel(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const words = value.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const typecastVoice: VoiceProviderDefinition = {
  catalog: {
    name: "Typecast",
    description: "Expressive voices that pick up emotion from the text.",
    transcribe: false,
    speechModel: true,
    speechModels: true,
  },
  create: () => new TypecastVoiceProvider(),
};
