import type { OpenAiCompatibleModelInfo, OpenAiCompatiblePreset } from "@rakazo/contracts";

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
  /** The form's text field for the output limit, lowered when the context limit leaves it no room. */
  maxTokens?: string;
};

/**
 * What to prefill when a person picks a model the probe described; nothing for an unknown one.
 * A context limit the current output limit would not fit under lowers the output limit with it,
 * so the form still saves. A one-token context leaves no valid output limit, so it is not filled.
 */
export function probedModelPrefill(
  details: readonly OpenAiCompatibleModelInfo[],
  modelId: string,
  currentMaxTokens: string,
): ProbedModelPrefill {
  const info = details.find((entry) => entry.id === modelId);
  if (!info) return {};
  const prefill: ProbedModelPrefill = {
    ...(info.reasoning !== undefined ? { reasoning: info.reasoning } : {}),
    ...(info.supportsImages !== undefined ? { supportsImages: info.supportsImages } : {}),
  };
  if (info.contextWindow !== undefined && info.contextWindow >= 2) {
    prefill.contextWindow = String(info.contextWindow);
    if (Number(currentMaxTokens) >= info.contextWindow) {
      prefill.maxTokens = String(Math.max(1, Math.floor(info.contextWindow / 2)));
    }
  }
  return prefill;
}
