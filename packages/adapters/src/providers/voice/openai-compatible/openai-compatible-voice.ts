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
  ConnectionSetupError,
  DEFAULT_COMPATIBLE_STT_MODEL,
  DEFAULT_COMPATIBLE_TTS_MODEL,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@rakazo/contracts";
import { deadlineSignal } from "@rakazo/core";
import {
  assertAllowedOpenAiCompatibleUrl,
  assertHttpsForKeyedOpenAiCompatibleUrl,
  normalizeOpenAiCompatibleBaseUrl,
  openAiCompatAllowPublicHosts,
} from "../../../openai-compatible-url.js";
import { createOpenAiCompatibleFetch } from "../../../pi-openai-compatible-provider.js";
import {
  readVoiceAudio,
  readVoiceJson,
  readVoiceText,
  speechUploadName,
  voiceErrorDetail,
  voiceHttpError,
  voiceLanguageHint,
  voiceRequestError,
} from "../../../voice-http.js";
import type { VoiceProviderDefinition } from "../../../voice-provider-descriptor.js";
import { OPENAI_VOICES } from "../openai/openai-voice.js";

export { DEFAULT_COMPATIBLE_STT_MODEL, DEFAULT_COMPATIBLE_TTS_MODEL };
export const OPENAI_COMPATIBLE_VOICE_PROVIDER_ID = OPENAI_COMPATIBLE_PROVIDER_ID;

const PROVIDER_NAME = "The speech server";
const MAX_MODEL_ID_LENGTH = 200;
const VERIFY_DEADLINE_MS = 20_000;
const LIST_VOICES_DEADLINE_MS = 15_000;
const SPEAK_DEADLINE_MS = 60_000;
const TRANSCRIBE_DEADLINE_MS = 60_000;
const MODEL_ID_PATTERN = /^[\w.:/@+-]+$/;
/** Visible ASCII only, so a key can never break the Authorization header. */
const API_KEY_PATTERN = /^[\x21-\x7e]+$/;
const MAX_SERVER_DETAIL_LENGTH = 160;
/** A voice list is shown to the user, so it stays small: ids, short names, a few hundred. */
const MAX_LISTED_VOICES = 500;
const MAX_VOICE_LABEL_LENGTH = 120;
/** Off-the-shelf voice ids are short and boring, so anything else in a hint is dropped. */
const SUGGESTED_VOICE_ID = /^[\w.-]{1,64}$/;
const MAX_SUGGESTED_VOICES = 8;
const SUGGESTION_TAIL_LENGTH = 400;
const MAX_SUGGESTION_LEAD = 20;
/** "supported voice(s):", "try using a supported voice:", "valid voices are:". */
const VOICE_HINT_PHRASE =
  /\b(?:supported|valid|available|allowed)\s+voices?|\btry\s+(?:using\s+)?(?:one\s+of\s+)?(?:the\s+|a\s+)?(?:supported\s+|valid\s+)?voices?/i;

/** What the encrypted voice secret holds for a self-hosted speech server. */
export interface OpenAiCompatibleVoiceSecret {
  kind: "openai_compatible";
  baseUrl: string;
  /** An explicit transcription server. Absent when transcription inherits the main connection. */
  sttBaseUrl?: string;
  apiKey?: string;
  /** Sent only to `sttBaseUrl`; `apiKey` never reaches the transcription server. */
  sttApiKey?: string;
  ttsModel: string;
  sttModel: string;
}

/** Names the field a refused transcription URL came from; any other failure passes through. */
function transcriptionUrlError(error: unknown): unknown {
  return error instanceof ConnectionSetupError
    ? new ConnectionSetupError(`Transcription server URL: ${error.message}`)
    : error;
}

function modelIdOrDefault(value: string | undefined, fallback: string, label: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return fallback;
  if (trimmed.length > MAX_MODEL_ID_LENGTH || !MODEL_ID_PATTERN.test(trimmed)) {
    throw new ConnectionSetupError(`${label} model id is not valid.`);
  }
  return trimmed;
}

/**
 * Validate the connection form and return the secret plaintext to store. The base URL
 * gets /v1 like model connections do; public hosts stay behind the same gate, and so
 * does a separate transcription server, which has its own key. Blank fields keep the
 * previous keys and models, but only for the same server, so a key is never carried to
 * a new address. An omitted transcription server keeps the previous one; blank means the
 * main server transcribes.
 */
export function serializeOpenAiCompatibleVoiceSecret(
  input: {
    baseUrl: string;
    sttBaseUrl?: string;
    apiKey?: string;
    sttApiKey?: string;
    ttsModel?: string;
    sttModel?: string;
  },
  previousPlaintext?: string,
  policy?: { allowPrivate?: boolean },
): string {
  const url = assertAllowedOpenAiCompatibleUrl(input.baseUrl, policy);
  const baseUrl = normalizeOpenAiCompatibleBaseUrl(input.baseUrl);
  const previous = previousPlaintext ? tryParseSecret(previousPlaintext) : undefined;
  const same = previous?.baseUrl === baseUrl ? previous : undefined;
  // The transcription server and its key belong together, whatever happens to the main one.
  const sttInput = input.sttBaseUrl === undefined ? previous?.sttBaseUrl : input.sttBaseUrl.trim();
  let sttUrl: URL | undefined;
  try {
    sttUrl = sttInput ? assertAllowedOpenAiCompatibleUrl(sttInput, policy) : undefined;
  } catch (error) {
    throw transcriptionUrlError(error);
  }
  const sttBaseUrl = sttInput ? normalizeOpenAiCompatibleBaseUrl(sttInput) : undefined;
  const sameStt =
    previous && (previous.sttBaseUrl ?? previous.baseUrl) === (sttBaseUrl ?? baseUrl)
      ? previous
      : undefined;
  const apiKey = input.apiKey?.trim() || same?.apiKey;
  const sttApiKey = sttBaseUrl
    ? input.sttApiKey?.trim() ||
      (previous?.sttBaseUrl === sttBaseUrl ? previous.sttApiKey : undefined)
    : undefined;
  for (const key of [apiKey, sttApiKey]) {
    if (key && !API_KEY_PATTERN.test(key)) {
      throw new ConnectionSetupError("That API key has characters a key cannot contain.");
    }
  }
  assertHttpsForKeyedOpenAiCompatibleUrl(url, apiKey);
  if (sttUrl) {
    try {
      assertHttpsForKeyedOpenAiCompatibleUrl(sttUrl, sttApiKey);
    } catch (error) {
      throw transcriptionUrlError(error);
    }
  }
  const secret: OpenAiCompatibleVoiceSecret = {
    kind: "openai_compatible",
    baseUrl,
    ...(sttBaseUrl ? { sttBaseUrl: sttBaseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(sttApiKey ? { sttApiKey } : {}),
    ttsModel: modelIdOrDefault(
      input.ttsModel || same?.ttsModel,
      DEFAULT_COMPATIBLE_TTS_MODEL,
      "Speech",
    ),
    sttModel: modelIdOrDefault(
      input.sttModel || sameStt?.sttModel,
      DEFAULT_COMPATIBLE_STT_MODEL,
      "Transcription",
    ),
  };
  return JSON.stringify(secret);
}

function tryParseSecret(plaintext: string): OpenAiCompatibleVoiceSecret | undefined {
  try {
    return parseOpenAiCompatibleVoiceSecret(plaintext);
  } catch {
    return undefined;
  }
}

export function parseOpenAiCompatibleVoiceSecret(plaintext: string): OpenAiCompatibleVoiceSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error("Saved speech server settings are unreadable. Connect the server again.");
  }
  const record = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  if (record.kind !== "openai_compatible" || typeof record.baseUrl !== "string") {
    throw new Error("Saved speech server settings are unreadable. Connect the server again.");
  }
  return {
    kind: "openai_compatible",
    baseUrl: record.baseUrl,
    ...(typeof record.sttBaseUrl === "string" && record.sttBaseUrl
      ? { sttBaseUrl: record.sttBaseUrl }
      : {}),
    ...(typeof record.apiKey === "string" && record.apiKey ? { apiKey: record.apiKey } : {}),
    ...(typeof record.sttApiKey === "string" && record.sttApiKey
      ? { sttApiKey: record.sttApiKey }
      : {}),
    ttsModel: typeof record.ttsModel === "string" ? record.ttsModel : DEFAULT_COMPATIBLE_TTS_MODEL,
    sttModel: typeof record.sttModel === "string" ? record.sttModel : DEFAULT_COMPATIBLE_STT_MODEL,
  };
}

/** The non-secret part of a saved connection, for settings and disclosures. */
export interface OpenAiCompatibleVoiceServer {
  endpoint: string;
  /** Empty when the main server transcribes. */
  sttEndpoint: string;
  ttsModel: string;
  sttModel: string;
}

/** Undefined when the saved secret is unreadable. Never includes the key. */
export function openAiCompatibleVoiceServer(
  plaintext: string,
): OpenAiCompatibleVoiceServer | undefined {
  const secret = tryParseSecret(plaintext);
  if (!secret) return undefined;
  try {
    return {
      endpoint: normalizeOpenAiCompatibleBaseUrl(secret.baseUrl),
      sttEndpoint: secret.sttBaseUrl ? normalizeOpenAiCompatibleBaseUrl(secret.sttBaseUrl) : "",
      ttsModel: secret.ttsModel,
      sttModel: secret.sttModel,
    };
  } catch {
    return undefined;
  }
}

/**
 * Any private address is allowed, so echo only a short, single-line error from the
 * server: enough for "model not found", too little to read another service through it.
 */
function serverError(status: number, what: string, body: unknown, apiKey?: string): Error {
  const raw = voiceErrorDetail(body);
  const redacted = apiKey ? raw.replaceAll(apiKey, "[redacted]") : raw;
  const short = redacted
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .trim()
    .slice(0, MAX_SERVER_DETAIL_LENGTH);
  return voiceRequestError(status, PROVIDER_NAME, what, short ? { detail: short } : null, body);
}

/**
 * A strict server that refuses a voice usually names the ones the model takes
 * ("Try using a supported voice: Vivian, Serena, ..."), so offer those back rather than
 * leaving the user to guess. The phrase is matched first and the ids are read up to the
 * first sentence break, so a body that names no list yields nothing.
 */
export function suggestedVoices(body: unknown): string[] {
  let text: string;
  try {
    text = JSON.stringify(body) ?? "";
  } catch {
    return [];
  }
  const phrase = VOICE_HINT_PHRASE.exec(text);
  if (!phrase) return [];
  const end = phrase.index + phrase[0].length;
  const tail = text.slice(end, end + SUGGESTION_TAIL_LENGTH).replaceAll("\\", "");
  const colon = tail.indexOf(":");
  if (colon === -1 || colon > MAX_SUGGESTION_LEAD) return [];
  const voices: string[] = [];
  // "voice.v1" is one id, so a period only splits when it ends a sentence. Commas,
  // semicolons and newlines always do.
  const listed = tail
    .slice(colon + 1)
    .replace(/\.(?=\s|$)/g, "\n")
    .replace(/[;,]/g, "\n");
  for (const part of listed.split("\n")) {
    if (voices.length >= MAX_SUGGESTED_VOICES) break;
    // The slice carries the closing JSON quoting, so trim to the id grammar first and drop the
    // sentence period a last entry can end with.
    const id = part
      .trim()
      .replace(/^[^\w.-]+|[^\w.-]+$/g, "")
      .replace(/\.$/, "");
    if (!/[a-z0-9]/i.test(id) || !SUGGESTED_VOICE_ID.test(id) || voices.includes(id)) continue;
    voices.push(id);
  }
  return voices;
}

/** A strict server names the key it refuses, so that key can be dropped and retried. */
const UNRECOGNIZED_KEY_WORD =
  /unrecognized|unrecognised|unknown|unexpected|unsupported|not allowed|extra/i;

function rejectsKey(body: unknown, key: string): boolean {
  if (!body) return false;
  let text: string;
  try {
    text = JSON.stringify(body);
  } catch {
    return false;
  }
  // The field is named either as a JSON string in a structured `keys` array or in prose, where
  // a server may quote it with single quotes, backticks or nothing at all. The bare name has to
  // count too, or "Unrecognized key(s) in object: 'lang_code'" only works when a keys array
  // happens to accompany it.
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = new RegExp(`(^|["'\\s])["'\`]?${escaped}["'\`]?($|[^\\w])`);
  return named.test(text) && UNRECOGNIZED_KEY_WORD.test(text);
}

const KOKORO_ID = /^([abefhijpz])([fm])_([a-z]+)$/;
const KOKORO_LANGUAGES: Record<string, string> = {
  a: "American English",
  b: "British English",
  e: "Spanish",
  f: "French",
  h: "Hindi",
  i: "Italian",
  j: "Japanese",
  p: "Brazilian Portuguese",
  z: "Mandarin Chinese",
};

/** Kokoro's language code is the voice id's first letter (af_heart → "a"). */
export function kokoroLangCode(voiceId: string): string | undefined {
  return KOKORO_ID.exec(voiceId)?.[1];
}

function voiceInfo(id: string, name?: string): VoiceInfo {
  const kokoro = KOKORO_ID.exec(id);
  if (!kokoro) {
    const label = name
      ?.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
      .trim()
      .slice(0, MAX_VOICE_LABEL_LENGTH);
    return { id, label: label || id };
  }
  const [, lang, gender, base] = kokoro as unknown as [string, string, string, string];
  return {
    id,
    label: base.charAt(0).toUpperCase() + base.slice(1),
    description: `${KOKORO_LANGUAGES[lang]}, ${gender === "f" ? "female" : "male"}`,
  };
}

/** Shown when a Kokoro server has no voice list. af_heart first: it becomes the default. */
const KOKORO_FALLBACK_VOICES = [
  "af_heart",
  "af_bella",
  "af_nicole",
  "am_michael",
  "am_fenrir",
  "bf_emma",
  "bm_george",
  "bm_fable",
].map((id) => voiceInfo(id));

/** Other speech models, including hosted gateways, take the standard OpenAI voice names. */
function fallbackVoices(ttsModel: string): VoiceInfo[] {
  return /kokoro/i.test(ttsModel) ? KOKORO_FALLBACK_VOICES : OPENAI_VOICES;
}

/**
 * OpenAI has no voice list endpoint. Self-hosted servers answer GET /audio/voices in
 * one of these shapes: `{ data: [{ id, name }] }` (mlx-audio), `{ voices: [{ id, name }] }`
 * or `{ voices: ["af_heart"] }` (Kokoro-FastAPI), or a bare array of either.
 */
export function parseCompatibleVoiceList(body: unknown): VoiceInfo[] {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const entries = Array.isArray(body)
    ? body
    : Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.voices)
        ? record.voices
        : [];
  const voices: VoiceInfo[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const id =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object"
          ? (entry as { id?: unknown }).id
          : undefined;
    if (voices.length >= MAX_LISTED_VOICES) break;
    if (typeof id !== "string" || !id.trim() || id.length > 120 || seen.has(id)) continue;
    seen.add(id);
    const name =
      entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined;
    voices.push(voiceInfo(id, typeof name === "string" ? name : undefined));
  }
  const preferred = voices.findIndex((voice) => voice.id === "af_heart");
  if (preferred > 0) voices.unshift(...voices.splice(preferred, 1));
  return voices;
}

function headers(secret: OpenAiCompatibleVoiceSecret, extra?: Record<string, string>) {
  return bearer(secret.apiKey, extra);
}

function bearer(apiKey: string | undefined, extra?: Record<string, string>) {
  return {
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...extra,
  };
}

function endpoint(secret: OpenAiCompatibleVoiceSecret, path: string, baseUrl = secret.baseUrl) {
  return `${normalizeOpenAiCompatibleBaseUrl(baseUrl)}/${path}`;
}

/**
 * A self-hosted OpenAI-compatible speech server (mlx-audio, Kokoro-FastAPI, Speaches)
 * at a user-supplied base URL. The `apiKey` argument carries the serialized
 * {@link OpenAiCompatibleVoiceSecret}, not a bare key.
 */
export class OpenAiCompatibleVoiceProvider implements VoiceProvider {
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: { fetch?: typeof globalThis.fetch; allowPrivateEndpoint?: boolean } = {}) {
    this.fetch = createOpenAiCompatibleFetch(options.fetch, undefined, {
      allowPrivate: options.allowPrivateEndpoint,
    });
  }

  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: OPENAI_COMPATIBLE_VOICE_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: true },
    };
  }

  /** GET /models proves reachability and the key; servers without it may still list voices. */
  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    let secret: OpenAiCompatibleVoiceSecret;
    try {
      secret = parseOpenAiCompatibleVoiceSecret(apiKey);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    const signal = deadlineSignal(VERIFY_DEADLINE_MS, context.signal);
    const origin = new URL(secret.baseUrl).origin;
    try {
      let res = await this.fetch(endpoint(secret, "models"), {
        headers: headers(secret),
        signal,
      });
      if (res.status === 404 || res.status === 405) {
        await res.body?.cancel().catch(() => undefined);
        res = await this.fetch(
          `${endpoint(secret, "audio/voices")}?model=${encodeURIComponent(secret.ttsModel)}`,
          { headers: headers(secret), signal },
        );
      }
      if (res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: true };
      }
      await res.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        message: voiceHttpError(res.status, PROVIDER_NAME, "Checking the speech server", null),
      };
    } catch (error) {
      if (context.signal.aborted) throw error;
      return { ok: false, message: `Couldn't reach the speech server at ${origin}.` };
    }
  }

  async listVoices(apiKey: string, context: AdapterContext): Promise<VoiceInfo[]> {
    const secret = parseOpenAiCompatibleVoiceSecret(apiKey);
    try {
      const res = await this.fetch(
        `${endpoint(secret, "audio/voices")}?model=${encodeURIComponent(secret.ttsModel)}`,
        {
          headers: headers(secret),
          signal: deadlineSignal(LIST_VOICES_DEADLINE_MS, context.signal),
        },
      );
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return fallbackVoices(secret.ttsModel);
      }
      const voices = parseCompatibleVoiceList(await readVoiceJson(res));
      return voices.length ? voices : fallbackVoices(secret.ttsModel);
    } catch (error) {
      // A server that cannot list voices still speaks; a blocked address is a real error.
      if (context.signal.aborted || !(error instanceof Error) || !isNetworkError(error))
        throw error;
      return fallbackVoices(secret.ttsModel);
    }
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const secret = parseOpenAiCompatibleVoiceSecret(request.apiKey);
    const signal = deadlineSignal(SPEAK_DEADLINE_MS, request.signal ?? context.signal);
    // Set once the server has refused lang_code, so no later attempt sends it again.
    let langRefused = false;
    /**
     * Speaks with one voice. Kokoro servers otherwise read every voice with English
     * pronunciation, but strict servers reject the whole body over a key they do not know, so a
     * refusal naming lang_code is retried once without it. Resolves with the failed response's
     * body when the attempt still fails.
     */
    const attempt = async (voice: string): Promise<{ res: Response; refusal?: unknown }> => {
      const send = (lang: string | undefined) =>
        this.fetch(endpoint(secret, "audio/speech"), {
          method: "POST",
          headers: headers(secret, { "content-type": "application/json" }),
          body: JSON.stringify({
            model: secret.ttsModel,
            voice,
            input: request.text,
            response_format: "mp3",
            ...(lang ? { lang_code: lang } : {}),
          }),
          signal,
        });
      const langCode = langRefused ? undefined : kokoroLangCode(voice);
      let res = await send(langCode);
      if (res.ok) return { res };
      let refusal = await readVoiceJson(res);
      if (langCode && isRefusal(res) && rejectsKey(refusal, "lang_code")) {
        langRefused = true;
        res = await send(undefined);
        if (res.ok) return { res };
        refusal = await readVoiceJson(res);
      }
      return { res, refusal };
    };
    const first = await attempt(request.voiceId);
    if (first.res.ok) return speechClip(first.res, signal);
    // A strict server that refuses the voice may name the ones the model takes; trying the
    // first keeps the request alive, and the clip reports the voice it really used.
    const alternative = isRefusal(first.res)
      ? suggestedVoices(first.refusal).find((voice) => voice !== request.voiceId)
      : undefined;
    if (!alternative) {
      throw serverError(first.res.status, "speaking", first.refusal, secret.apiKey);
    }
    const second = await attempt(alternative);
    if (second.res.ok) return speechClip(second.res, signal, alternative);
    throw serverError(second.res.status, "speaking", second.refusal, secret.apiKey);
  }

  async transcribe(
    request: VoiceTranscribeRequest,
    context: AdapterContext,
  ): Promise<{ text: string }> {
    const secret = parseOpenAiCompatibleVoiceSecret(request.apiKey);
    const apiKey = secret.sttBaseUrl ? secret.sttApiKey : secret.apiKey;
    const form = new FormData();
    form.set("model", secret.sttModel);
    // mlx-audio streams NDJSON unless asked for the OpenAI shape.
    form.set("response_format", "json");
    const language = voiceLanguageHint(request.language);
    if (language) form.set("language", language);
    form.set(
      "file",
      new Blob([new Uint8Array(request.audio)], { type: request.mimeType || "audio/webm" }),
      speechUploadName(request.mimeType),
    );
    const url = endpoint(secret, "audio/transcriptions", secret.sttBaseUrl);
    const res = await this.fetch(url, {
      method: "POST",
      headers: bearer(apiKey),
      body: form,
      signal: deadlineSignal(TRANSCRIBE_DEADLINE_MS, request.signal ?? context.signal),
    });
    const raw = await readVoiceText(res);
    const type = mediaType(res);
    if (!res.ok) {
      throw serverError(res.status, "transcribing", parseJson(raw), apiKey);
    }
    if (type && type !== "text/plain" && type !== "application/json") {
      throw new Error(`${PROVIDER_NAME} did not return a transcript.`);
    }
    const parsed = parseJson(raw);
    if (parsed && typeof parsed === "object") {
      return { text: String((parsed as { text?: unknown }).text ?? "").trim() };
    }
    // Anything else that is not labelled JSON is the transcript itself, even "1234" or "null".
    if (type === "application/json" || raw === null) {
      throw new Error(`${PROVIDER_NAME} did not return a transcript.`);
    }
    return { text: raw.trim() };
  }
}

function isRefusal(res: Response): boolean {
  return res.status === 400 || res.status === 422;
}

/** mp3 was requested; servers label it audio/mpeg or audio/mp3. Anything else is not a clip. */
async function speechClip(
  res: Response,
  signal: AbortSignal,
  voiceId?: string,
): Promise<SpeechClip> {
  const type = mediaType(res);
  if (type !== "audio/mpeg" && type !== "audio/mp3") {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`${PROVIDER_NAME} did not return MP3 audio.`);
  }
  return {
    bytes: await readVoiceAudio(res, signal),
    mimeType: "audio/mpeg",
    ...(voiceId ? { voiceId } : {}),
  };
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function mediaType(res: Response): string {
  return (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function isNetworkError(error: Error): boolean {
  return error.name === "TypeError" || error.name === "AbortError" || error.name === "TimeoutError";
}

export const openAiCompatibleVoice: VoiceProviderDefinition = {
  catalog: {
    name: "Self-hosted",
    description: "Any OpenAI-compatible speech server, like Kokoro or Whisper.",
    transcribe: true,
  },
  listed: ({ allowPrivateEndpoint }) =>
    allowPrivateEndpoint === true || openAiCompatAllowPublicHosts(),
  create: ({ allowPrivateEndpoint }) => new OpenAiCompatibleVoiceProvider({ allowPrivateEndpoint }),
};
