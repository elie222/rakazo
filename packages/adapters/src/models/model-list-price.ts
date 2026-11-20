import {
  CLAUDE_CODE_PROVIDER_ID,
  claudeCodeListPrice,
} from "../providers/cli-model/claude-code/provider.js";
import { catalogModels } from "./model-vision.js";

export const USAGE_TOKEN_BUCKETS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
] as const;
export type UsageTokenBucket = (typeof USAGE_TOKEN_BUCKETS)[number];

/** Calls without a cost of their own: how many, how many report each count, and the counts' sums. */
export type UnpricedUsage = {
  calls: number;
  counted: Record<UsageTokenBucket, number>;
  tokens: Record<UsageTokenBucket, number>;
};

/**
 * What the calls would cost at the model's list API price, such as calls a subscription covers.
 * Null when the catalog lists no price. `complete` is false when some call left out a count the
 * price charges for, so `usd` is a floor. Uses the base rates, so a model priced in tiers by
 * request size reads as its lowest tier.
 */
export function modelListCost(
  provider: string,
  modelId: string,
  usage: UnpricedUsage,
): { usd: number; complete: boolean } | null {
  const models = catalogModels();
  const price =
    provider === CLAUDE_CODE_PROVIDER_ID
      ? claudeCodeListPrice(modelId, models)
      : models.getModel(provider, modelId)?.cost;
  if (!price) return null;
  const rates: Record<UsageTokenBucket, number> = {
    inputTokens: price.input,
    outputTokens: price.output,
    cacheReadTokens: price.cacheRead,
    cacheWriteTokens: price.cacheWrite,
  };
  if (!USAGE_TOKEN_BUCKETS.some((bucket) => rates[bucket] > 0)) return null;
  // The Claude Code CLI reports every count, and Pi stores its zero cache counts as absent.
  const absentMeansZero = (bucket: UsageTokenBucket) =>
    provider === CLAUDE_CODE_PROVIDER_ID &&
    (bucket === "cacheReadTokens" || bucket === "cacheWriteTokens");
  return {
    usd:
      USAGE_TOKEN_BUCKETS.reduce((sum, bucket) => sum + usage.tokens[bucket] * rates[bucket], 0) /
      1_000_000,
    complete: USAGE_TOKEN_BUCKETS.every(
      (bucket) =>
        usage.counted[bucket] === usage.calls || rates[bucket] === 0 || absentMeansZero(bucket),
    ),
  };
}
