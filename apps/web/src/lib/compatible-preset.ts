import { t } from "@lingui/core/macro";
import type { OpenAiCompatibleModelInfo } from "@rakazo/contracts";
import { openAiCompatiblePresetFor } from "@rakazo/contracts";

/** Placeholder for the API key field of a hosted preset; undefined for an ordinary server. */
export function presetApiKeyPlaceholder(baseUrl: string | undefined): string | undefined {
  switch (openAiCompatiblePresetFor(baseUrl)?.id) {
    case "ollama-cloud":
      return t`Ollama API key`;
    case "deepinfra":
      return t`DeepInfra API key`;
    default:
      return undefined;
  }
}

/** Short capability hints for a discovered model, such as "Images · Thinking". */
export function modelCapabilityHint(info: OpenAiCompatibleModelInfo | undefined): string {
  if (!info) return "";
  return [info.supportsImages ? t`Images` : "", info.reasoning ? t`Thinking` : ""]
    .filter(Boolean)
    .join(" · ");
}

export type ProbedModelFields = {
  supportsImages?: boolean;
  reasoning?: boolean;
  contextWindow?: string;
  maxTokens?: string;
};

/**
 * Connection form values a model listing implies. Fields the server did not publish are left
 * out, so the user's own values stay. A published context limit that the current output limit
 * would not leave room in lowers the output limit with it, so the form still saves. A one-token
 * context leaves no valid output limit at all, so it is not prefilled.
 */
export function probedModelFields(
  info: OpenAiCompatibleModelInfo | undefined,
  currentMaxTokens: string,
): ProbedModelFields {
  if (!info) return {};
  const fields: ProbedModelFields = {};
  if (info.supportsImages !== undefined) fields.supportsImages = info.supportsImages;
  if (info.reasoning !== undefined) fields.reasoning = info.reasoning;
  if (info.contextWindow !== undefined && info.contextWindow >= 2) {
    fields.contextWindow = String(info.contextWindow);
    const maxTokens = Number(currentMaxTokens);
    if (Number.isInteger(maxTokens) && maxTokens >= info.contextWindow) {
      fields.maxTokens = String(Math.max(1, Math.floor(info.contextWindow / 2)));
    }
  }
  return fields;
}
