import { DEFAULT_MODEL_MAX_TOKENS } from "@rakazo/contracts";

/** Hung completions must fail before the typical 5-minute run lease. */
export const MODEL_STREAM_TIMEOUT_MS = 120_000;
/** One retry keeps a transient blip from killing the turn without outliving the lease. */
export const MODEL_STREAM_MAX_RETRIES = 1;

export const TOOL_RESULT_TEXT_LIMIT = 12_000;

export function clipToolResultText(text: string, limit: number = TOOL_RESULT_TEXT_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Prompt tokens providers bill, including cache read/write rather than the uncached remainder. */
export function billedPromptTokens(usage: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens:
      nonNegativeCount(usage.input) +
      nonNegativeCount(usage.cacheRead) +
      nonNegativeCount(usage.cacheWrite),
    outputTokens: nonNegativeCount(usage.output),
  };
}

/**
 * Completions default to a modest output cap so OpenRouter-style providers do not
 * hold credit for a model card's 128k ceiling. A configured maxTokens is the escape.
 */
export function resolveCompletionMaxTokens(
  modelMaxTokens?: number,
  configuredMaxTokens?: number,
  optionsMaxTokens?: number,
): number {
  const userCap =
    typeof configuredMaxTokens === "number" && configuredMaxTokens >= 1
      ? configuredMaxTokens
      : DEFAULT_MODEL_MAX_TOKENS;
  const optionCap =
    typeof optionsMaxTokens === "number" && optionsMaxTokens >= 1
      ? Math.min(optionsMaxTokens, userCap)
      : userCap;
  if (typeof modelMaxTokens === "number" && modelMaxTokens >= 1) {
    return Math.min(modelMaxTokens, optionCap);
  }
  return optionCap;
}

function nonNegativeCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}
