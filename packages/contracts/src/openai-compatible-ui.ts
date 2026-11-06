import type { OpenAiCompatiblePreset } from "./domain.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./domain.js";

function matchesPresetBaseUrl(baseUrl: string | undefined, presetBaseUrl: string): boolean {
  try {
    return normalizeOpenAiCompatibleBaseUrl(baseUrl ?? "") === presetBaseUrl;
  } catch {
    return false;
  }
}

/**
 * The hosted preset a base URL points at, if any. The server owns the preset list and sends it
 * to every app, so no app names a service itself.
 */
export function openAiCompatiblePresetFor(
  presets: readonly OpenAiCompatiblePreset[],
  baseUrl: string | undefined,
): OpenAiCompatiblePreset | undefined {
  return presets.find((preset) => matchesPresetBaseUrl(baseUrl, preset.baseUrl));
}

/** Base URLs of the hosted presets that already have a saved connection, one per preset. */
export function connectedPresetBaseUrls(
  presets: readonly OpenAiCompatiblePreset[],
  credentials: readonly { provider: string; baseUrl?: string }[],
): Set<string> {
  const connected = new Set<string>();
  for (const credential of credentials) {
    const preset =
      credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? openAiCompatiblePresetFor(presets, credential.baseUrl)
        : undefined;
    if (preset) connected.add(preset.baseUrl);
  }
  return connected;
}

/** Hosted presets refuse keyless requests, so their key field is required. */
export function openAiCompatibleKeyRequired(
  presets: readonly OpenAiCompatiblePreset[],
  baseUrl: string | undefined,
): boolean {
  return openAiCompatiblePresetFor(presets, baseUrl)?.keyRequired ?? false;
}

export function compatibleConnectionName(
  presets: readonly OpenAiCompatiblePreset[],
  baseUrl: string | undefined,
  fallback: string,
): string {
  return openAiCompatiblePresetFor(presets, baseUrl)?.name ?? fallback;
}

export const OPENAI_COMPATIBLE_BASE_URL_HINT =
  "Paste the OpenAI-compatible address from your server. Rakazo adds /v1 if needed.";

/** Connect when base URL and model id are set. */
export function openAiCompatibleConnectReady(input: {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  /** The endpoint is a hosted preset that refuses requests without a key. */
  keyRequired?: boolean;
}): boolean {
  return Boolean(
    input.baseUrl.trim() && input.modelId.trim() && (!input.keyRequired || input.apiKey?.trim()),
  );
}

export function openAiCompatibleProbeSuccessMessage(modelCount: number): string {
  return modelCount
    ? `Found ${modelCount} model${modelCount === 1 ? "" : "s"}.`
    : "Server found. Enter a model name.";
}

/** The canonical endpoint the server stores: trailing slashes dropped, `/v1` added only when no
 * path segment is already a version (`v1`, `v4`, `v1beta`, ...), so gateways that route models by
 * path (`/v1/some-model`) keep their URL verbatim. */
export function normalizeOpenAiCompatibleBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Base URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("Base URL must not contain credentials");
  }
  let path = url.pathname.replace(/\/+$/, "") || "";
  const VERSION_SEGMENT = /^v\d+[a-z]*$/;
  if (!path.split("/").some((segment) => VERSION_SEGMENT.test(segment))) {
    path = path ? `${path}/v1` : "/v1";
  }
  return `${url.origin}${path}`;
}

/** Self-hosted voice defaults: Kokoro and Whisper as mlx-audio names them. */
export const DEFAULT_COMPATIBLE_TTS_MODEL = "mlx-community/Kokoro-82M-bf16";
export const DEFAULT_COMPATIBLE_STT_MODEL = "mlx-community/whisper-large-v3-turbo-asr-fp16";

/** Preferred default, explicit enabled id (preferred first), then a list-less legacy fallback.
 * Candidates must be in stable credential order, newest first.
 */
export function selectCompatibleModelCredential<
  C extends {
    defaultModel?: string | null;
    enabledModelIds?: readonly string[] | null;
  },
>(preferred: C, candidates: readonly C[], modelId: string): C | undefined {
  if (preferred.defaultModel === modelId || preferred.enabledModelIds?.includes(modelId))
    return preferred;
  return (
    candidates.find((candidate) => candidate.enabledModelIds?.includes(modelId)) ??
    (preferred.enabledModelIds === undefined ? preferred : undefined)
  );
}

/** Match a typed endpoint to the canonical saved endpoint; incomplete input never matches. */
export function savedCompatibleEndpointMatches(
  baseUrl: string,
  savedBaseUrl: string | undefined,
): boolean {
  try {
    return Boolean(savedBaseUrl) && normalizeOpenAiCompatibleBaseUrl(baseUrl) === savedBaseUrl;
  } catch {
    return false;
  }
}
