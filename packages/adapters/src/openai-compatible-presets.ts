import type { OpenAiCompatiblePreset } from "@rakazo/contracts";
import { openAiCompatiblePresetFor } from "@rakazo/contracts";

export const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";

/** DeepInfra serves its OpenAI-compatible API under /v1/openai. */
export const DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai";

/**
 * Hosted OpenAI-compatible services offered as presets. Each needs an API key, and the connection
 * is saved under the OpenAI-compatible provider with the preset's base URL. The apps read this
 * list from the server, so a service is added here and nowhere else.
 */
export const OPENAI_COMPATIBLE_PRESETS: readonly OpenAiCompatiblePreset[] = [
  { id: "ollama-cloud", name: "Ollama Cloud", baseUrl: OLLAMA_CLOUD_BASE_URL, keyRequired: true },
  { id: "deepinfra", name: "DeepInfra", baseUrl: DEEPINFRA_BASE_URL, keyRequired: true },
];

/** The hosted preset a base URL points at, if any. */
export function hostedPresetFor(baseUrl: string | undefined): OpenAiCompatiblePreset | undefined {
  return openAiCompatiblePresetFor(OPENAI_COMPATIBLE_PRESETS, baseUrl);
}

export function isDeepInfraBaseUrl(baseUrl: string | undefined): boolean {
  return hostedPresetFor(baseUrl)?.baseUrl === DEEPINFRA_BASE_URL;
}
