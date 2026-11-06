import type {
  CacheCapabilities,
  OpenAiCompatibleModelInfo,
  OpenAiCompatiblePreset,
} from "@rakazo/contracts";

type Translate = (message: string) => string;

/** The preset's display name; brand names stay as they are in every language. */
export function presetName(preset: OpenAiCompatiblePreset, t: Translate): string {
  switch (preset.id) {
    case "ollama-cloud":
      return t("Ollama Cloud");
    case "deepinfra":
      return t("DeepInfra");
  }
}

/** The key field's placeholder for a hosted preset. */
export function presetKeyPlaceholder(preset: OpenAiCompatiblePreset, t: Translate): string {
  switch (preset.id) {
    case "ollama-cloud":
      return t("Ollama API key");
    case "deepinfra":
      return t("DeepInfra API key");
  }
}

/** Connection settings a server's model listing says about one model; absent means unknown. */
export type ProbedModelPrefill = {
  reasoning?: boolean;
  supportsImages?: boolean;
  /** The form's text field for the context limit. */
  contextWindow?: string;
  cacheCapabilities?: CacheCapabilities;
};

/** What to prefill when a person picks a model the probe described; nothing for an unknown one. */
export function probedModelPrefill(
  details: readonly OpenAiCompatibleModelInfo[],
  modelId: string,
): ProbedModelPrefill {
  const info = details.find((entry) => entry.id === modelId);
  if (!info) return {};
  return {
    ...(info.reasoning !== undefined ? { reasoning: info.reasoning } : {}),
    ...(info.supportsImages !== undefined ? { supportsImages: info.supportsImages } : {}),
    ...(info.contextWindow !== undefined ? { contextWindow: String(info.contextWindow) } : {}),
    ...(info.cacheCapabilities !== undefined ? { cacheCapabilities: info.cacheCapabilities } : {}),
  };
}
