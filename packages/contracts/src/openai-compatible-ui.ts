export const OPENAI_COMPATIBLE_BASE_URL_HINT =
  "Paste the OpenAI-compatible address from your server. Rakazo adds /v1 if needed.";

/** Connect when base URL and model id are set. Probe/stored URL are optional discovery. */
export function openAiCompatibleConnectReady(input: {
  baseUrl: string;
  modelId: string;
  probedBaseUrl?: string | null;
  storedBaseUrl?: string;
}): boolean {
  return Boolean(input.baseUrl.trim() && input.modelId.trim());
}

export function openAiCompatibleProbeSuccessMessage(modelCount: number): string {
  return modelCount
    ? `Found ${modelCount} model${modelCount === 1 ? "" : "s"}.`
    : "Server found. Enter a model name.";
}
