export const OPENAI_COMPATIBLE_BASE_URL_HINT =
  "Paste the OpenAI-compatible address from your server. Rakazo adds /v1 if needed.";

/** Connect when base URL and model id are set. */
export function openAiCompatibleConnectReady(input: { baseUrl: string; modelId: string }): boolean {
  return Boolean(input.baseUrl.trim() && input.modelId.trim());
}

export function openAiCompatibleProbeSuccessMessage(modelCount: number): string {
  return modelCount
    ? `Found ${modelCount} model${modelCount === 1 ? "" : "s"}.`
    : "Server found. Enter a model name.";
}

/** The canonical endpoint the server stores: trailing slashes dropped, `/v1` added when no `/vN`. */
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
  const VERSIONED_API_ROOT = /\/v\d+$/;
  if (!VERSIONED_API_ROOT.test(path)) {
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
