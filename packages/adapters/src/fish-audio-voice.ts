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
import { getLogger } from "@rakazo/logging";
import {
  readVoiceAudio,
  readVoiceJson,
  speechUploadName,
  verifyVoiceHttpGet,
  voiceDeadline,
  voiceHttpError,
} from "./voice-http.js";

const API = "https://api.fish.audio";
const MODEL_PAGE_SIZE = 100;
/** Top-scored public voices for the picker — not a full catalog crawl. */
const PUBLIC_MODEL_PAGES = 5;
/** User-owned libraries are smaller; still hard-capped. */
const OWN_MODEL_PAGES = 20;
const LIST_VOICES_DEADLINE_MS = 20_000;
const DEFAULT_TTS_MODEL = "s2.1-pro";
/** Header-safe Fish model id. A connection override wins over `FISH_TTS_MODEL`. */
const TTS_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UPSTREAM_DETAIL_LIMIT = 500;
let invalidTtsModelWarned = false;

export class FishAudioVoiceProvider implements VoiceProvider {
  /** Advertise Fish Audio's model catalog, speech synthesis, and transcription support. */
  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: "fish-audio",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: true },
    };
  }

  /** Verify the user's Fish Audio API key against the model catalog endpoint. */
  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    return verifyVoiceHttpGet({
      url: `${API}/model?page_size=1&page_number=1`,
      headers: fishAudioHeaders(apiKey),
      signal: context.signal,
      provider: "Fish Audio",
    });
  }

  /** Return user-owned then bounded public Fish Audio voices as Rakazo choices. */
  async listVoices(apiKey: string, context: AdapterContext): Promise<VoiceInfo[]> {
    const signal = voiceDeadline(context.signal, LIST_VOICES_DEADLINE_MS);
    const listContext = { ...context, signal };
    const [publicModels, ownModels] = await Promise.all([
      fetchModels(apiKey, listContext, false),
      fetchModels(apiKey, listContext, true),
    ]);
    const seen = new Set<string>();
    return [...ownModels, ...publicModels].map(modelToVoice).filter((voice): voice is VoiceInfo => {
      if (!voice || seen.has(voice.id)) return false;
      seen.add(voice.id);
      return true;
    });
  }

  /** Synthesize one Rakazo utterance as bounded MP3 audio. */
  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const signal = voiceDeadline(request.signal ?? context.signal, 60_000);
    const model = resolveFishSpeechModel(request.model);
    const res = await fetch(`${API}/v1/tts`, {
      method: "POST",
      headers: {
        ...fishAudioHeaders(request.apiKey),
        "content-type": "application/json",
        accept: "audio/mpeg",
        model,
      },
      body: JSON.stringify({
        text: request.text,
        reference_id: request.voiceId,
        format: "mp3",
        mp3_bitrate: 64,
        latency: "balanced",
        normalize: true,
      }),
      signal,
    });
    if (!res.ok) {
      rejectFish(res.status, "speaking", await readFishResponse(res), request.apiKey, model);
    }
    return { bytes: await readVoiceAudio(res, signal), mimeType: "audio/mpeg" };
  }

  /** Transcribe a browser recording through Fish Audio's multipart ASR endpoint. */
  async transcribe(
    request: VoiceTranscribeRequest,
    context: AdapterContext,
  ): Promise<{ text: string }> {
    const form = new FormData();
    form.set(
      "audio",
      new Blob([new Uint8Array(request.audio)], { type: request.mimeType || "audio/webm" }),
      speechUploadName(request.mimeType),
    );
    form.set("ignore_timestamps", "true");
    const res = await fetch(`${API}/v1/asr`, {
      method: "POST",
      headers: fishAudioHeaders(request.apiKey),
      body: form,
      signal: voiceDeadline(request.signal ?? context.signal, 60_000),
    });
    const body = await readFishResponse(res);
    if (!res.ok) rejectFish(res.status, "transcribing", body, request.apiKey);
    return { text: String((body as { text?: unknown } | null)?.text ?? "").trim() };
  }
}

/** Fetch public or user-owned Fish Audio voice models within a page budget. */
async function fetchModels(
  apiKey: string,
  context: AdapterContext,
  own: boolean,
): Promise<Array<Record<string, unknown>>> {
  const maxPages = own ? OWN_MODEL_PAGES : PUBLIC_MODEL_PAGES;
  const models: Array<Record<string, unknown>> = [];
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const params = new URLSearchParams({
      page_size: String(MODEL_PAGE_SIZE),
      page_number: String(pageNumber),
      sort_by: "score",
    });
    if (own) params.set("self", "true");
    const res = await fetch(`${API}/model?${params}`, {
      headers: fishAudioHeaders(apiKey),
      signal: context.signal,
    });
    const body = await readFishResponse(res);
    if (!res.ok) rejectFish(res.status, "listing voices", body, apiKey);
    const items = modelsFrom(body);
    models.push(...items);
    if (items.length === 0 || !modelPageHasMore(body, pageNumber, items.length)) break;
  }
  return models;
}

/** Decide whether another Fish Audio model page should be requested. */
function modelPageHasMore(body: unknown, pageNumber: number, itemCount: number): boolean {
  if (!body || typeof body !== "object") return false;
  const meta = body as { has_more?: unknown; total?: unknown };
  if (typeof meta.has_more === "boolean") return meta.has_more;
  if (typeof meta.total === "number" && Number.isFinite(meta.total)) {
    return pageNumber * MODEL_PAGE_SIZE < meta.total;
  }
  return itemCount === MODEL_PAGE_SIZE;
}

/** Build the authorization header shared by Fish Audio requests. */
function fishAudioHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

/** True when `value` can be sent as the Fish `model` header. */
export function isFishSpeechModelId(value: string): boolean {
  return TTS_MODEL_PATTERN.test(value);
}

/** Connection override, then `FISH_TTS_MODEL`, then s2.1-pro. */
function resolveFishSpeechModel(override?: string | null): string {
  const requested = override?.trim() ?? "";
  if (requested && isFishSpeechModelId(requested)) return requested;
  return deploymentFishSpeechModel();
}

/** `FISH_TTS_MODEL` when it is a single model id; otherwise s2.1-pro. */
function deploymentFishSpeechModel(): string {
  const configured = process.env.FISH_TTS_MODEL?.trim() ?? "";
  if (!configured) return DEFAULT_TTS_MODEL;
  if (isFishSpeechModelId(configured)) return configured;
  if (!invalidTtsModelWarned) {
    invalidTtsModelWarned = true;
    getLogger().warn("Ignoring FISH_TTS_MODEL because it is not a model id", {
      provider: "fish-audio",
    });
  }
  return DEFAULT_TTS_MODEL;
}

/** Read a Fish body. Error responses still return a safe message when the read fails. */
async function readFishResponse(res: Response): Promise<unknown> {
  try {
    return await readVoiceJson(res, { requireValid: res.ok, rawOnInvalid: !res.ok });
  } catch (error) {
    if (res.ok) throw error;
    return fishUnreadBody(error);
  }
}

function fishUnreadBody(error: unknown): { message: string } {
  if (error instanceof Error && error.message === "Voice response is too large.") {
    return { message: error.message };
  }
  return { message: "response body could not be read" };
}

/** Log the upstream Fish status and message, then raise the user-facing error. */
function rejectFish(
  status: number,
  what: string,
  body: unknown,
  apiKey: string,
  model?: string,
): never {
  const detail = fishErrorDetail(body, apiKey);
  getLogger().error("Fish Audio request failed", {
    provider: "fish-audio",
    operation: what,
    "http.status": status,
    ...(model ? { "fish.model": model } : {}),
    ...(detail ? { "error.detail": detail } : {}),
  });
  throw new Error(
    voiceHttpError(
      status,
      "Fish Audio",
      what,
      typeof body === "string" || !detail ? null : { message: detail },
    ),
  );
}

/** Upstream message, or a short raw body when Fish did not return JSON. */
function fishErrorDetail(body: unknown, apiKey: string): string {
  const text = typeof body === "string" ? body : upstreamMessage(body) || jsonFallback(body);
  return scrubSecret(text, apiKey).replace(/\s+/g, " ").trim().slice(0, UPSTREAM_DETAIL_LIMIT);
}

function upstreamMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  for (const key of ["detail", "message", "error"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (
      value &&
      typeof value === "object" &&
      typeof (value as { message?: unknown }).message === "string"
    ) {
      const message = (value as { message: string }).message.trim();
      if (message) return message;
    }
  }
  return "";
}

function jsonFallback(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  try {
    return JSON.stringify(body);
  } catch {
    return "";
  }
}

function scrubSecret(text: string, apiKey: string): string {
  const secret = apiKey.trim();
  if (secret.length < 8) return text;
  return text.split(secret).join("[Redacted]");
}

/** Extract object-shaped model entries from a Fish Audio list response. */
function modelsFrom(body: unknown): Array<Record<string, unknown>> {
  if (!body || typeof body !== "object") return [];
  const items = (body as { items?: unknown }).items;
  return Array.isArray(items)
    ? items.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object"),
      )
    : [];
}

/** Convert a Fish Audio model into the provider-neutral voice shape. */
function modelToVoice(model: Record<string, unknown>): VoiceInfo | null {
  if (model.dmca_taken_down === true || model.state === "failed") return null;
  const id = asText(model._id) || asText(model.id);
  if (!id) return null;
  const label = asText(model.title) || asText(model.name) || "Voice";
  const description =
    [asText(model.description), languageLabel(model.languages)].filter(Boolean).join(" · ") ||
    undefined;
  return { id, label, description };
}

/** Read a trimmed string field from an untyped provider response. */
function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Format the model language list for the voice picker description. */
function languageLabel(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .join(", ");
}
