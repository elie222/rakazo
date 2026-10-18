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

/** Self-hosted voice defaults: Kokoro and Whisper as mlx-audio names them. */
export const DEFAULT_COMPATIBLE_TTS_MODEL = "mlx-community/Kokoro-82M-bf16";
export const DEFAULT_COMPATIBLE_STT_MODEL = "mlx-community/whisper-large-v3-turbo-asr-fp16";
