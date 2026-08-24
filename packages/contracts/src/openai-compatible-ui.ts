export const OPENAI_COMPATIBLE_BASE_URL_HINT =
  "Paste the OpenAI-compatible address from your server. Rakazo adds /v1 if needed.";

export function openAiCompatibleConnectReady(input: {
  baseUrl: string;
  modelId: string;
  probedBaseUrl: string | null;
  storedBaseUrl?: string;
}): boolean {
  const trimmedUrl = input.baseUrl.trim();
  const trimmedModel = input.modelId.trim();
  if (!trimmedUrl || !trimmedModel) return false;
  const probeOk = input.probedBaseUrl === trimmedUrl;
  const storedOk = Boolean(input.storedBaseUrl && input.storedBaseUrl === trimmedUrl);
  return probeOk || storedOk;
}

export function openAiCompatibleProbeSuccessMessage(modelCount: number): string {
  return modelCount
    ? `Found ${modelCount} model${modelCount === 1 ? "" : "s"}.`
    : "Server found. Enter a model name.";
}
