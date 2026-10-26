/** UI preset only; saved connections use the OpenAI-compatible provider. */
export const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";

export function isOllamaCloudBaseUrl(baseUrl: string | undefined): boolean {
  try {
    return normalizeOpenAiCompatibleBaseUrl(baseUrl ?? "") === OLLAMA_CLOUD_BASE_URL;
  } catch {
    return false;
  }
}

export function compatibleConnectionName(baseUrl: string | undefined, fallback: string): string {
  return isOllamaCloudBaseUrl(baseUrl) ? "Ollama Cloud" : fallback;
}

export const OPENAI_COMPATIBLE_BASE_URL_HINT =
  "Paste the OpenAI-compatible address from your server. Rakazo adds /v1 if needed.";

/** Connect when base URL and model id are set. */
export function openAiCompatibleConnectReady(input: {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
}): boolean {
  return Boolean(
    input.baseUrl.trim() &&
      input.modelId.trim() &&
      (!isOllamaCloudBaseUrl(input.baseUrl) || input.apiKey?.trim()),
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
