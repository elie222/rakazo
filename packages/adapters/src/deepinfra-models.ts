import type { CacheCapabilities, OpenAiCompatibleModelInfo } from "@rakazo/contracts";
import { MAX_MODEL_CONTEXT_WINDOW, OpenAiCompatibleModelInfoSchema } from "@rakazo/contracts";

/** USD per 1M tokens; anything above this is a malformed listing, not a real price. */
const MAX_PRICE_PER_MILLION = 1_000_000;
const MAX_TAGS = 64;

type DeepInfraModelEntry = { id?: unknown; metadata?: unknown };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The model's string tags, or undefined when the listing gives no usable tags to judge by. */
function tagsOf(metadata: Record<string, unknown> | undefined): ReadonlySet<string> | undefined {
  const tags = metadata?.tags;
  if (!Array.isArray(tags) || tags.length > MAX_TAGS) return undefined;
  const valid = new Set(tags.filter((tag): tag is string => typeof tag === "string"));
  return valid.size > 0 ? valid : undefined;
}

function price(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_PRICE_PER_MILLION
    ? value
    : undefined;
}

function contextWindow(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_MODEL_CONTEXT_WINDOW
    ? value
    : undefined;
}

/** DeepInfra prices cached reads; how long its cache holds an entry is not published. */
function cacheCapabilities(
  tags: ReadonlySet<string>,
  metadata: Record<string, unknown>,
): CacheCapabilities | undefined {
  if (!tags.has("prompt_cache")) return undefined;
  const pricing = record(metadata.pricing);
  const readCostPerMillion = price(pricing?.cache_read_tokens);
  if (readCostPerMillion === undefined) return undefined;
  const inputCostPerMillion = price(pricing?.input_tokens);
  return {
    scope: "account",
    retentionMode: "short",
    ...(inputCostPerMillion === undefined ? {} : { inputCostPerMillion }),
    readCostPerMillion,
  };
}

function modelInfo(
  id: string,
  tags: ReadonlySet<string>,
  metadata: Record<string, unknown>,
): OpenAiCompatibleModelInfo | undefined {
  const window = contextWindow(metadata.context_length);
  const cache = cacheCapabilities(tags, metadata);
  const parsed = OpenAiCompatibleModelInfoSchema.safeParse({
    id,
    supportsImages: tags.has("vision") || tags.has("vlm"),
    // "reasoning" alone marks always-thinking models with no effort control; Rakazo's
    // thinking setting sends the standard reasoning_effort, which needs "reasoning_effort".
    reasoning: tags.has("reasoning_effort"),
    ...(window === undefined ? {} : { contextWindow: window }),
    ...(cache === undefined ? {} : { cacheCapabilities: cache }),
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * DeepInfra's `/models` lists every model it hosts (image, speech, embedding, ...) and tags each
 * in `metadata`. Keeps the chat models and reads their capabilities from the tags. A model whose
 * metadata has no usable tags (no list, an empty one, or no string tags) is kept without details,
 * since nothing says it is not a chat model.
 * Each entry is judged by its own metadata, and an id listed more than once is offered once, with
 * the details of an entry that describes it.
 */
export function deepInfraModelList(
  entries: ReadonlyArray<DeepInfraModelEntry>,
  ids: ReadonlyArray<string>,
): { models: string[]; details: OpenAiCompatibleModelInfo[] } {
  const accepted = new Set(ids);
  const kept = new Map<string, OpenAiCompatibleModelInfo | undefined>();
  for (const entry of entries) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!accepted.has(id)) continue;
    const metadata = record(entry.metadata);
    const tags = tagsOf(metadata);
    if (metadata && tags && !tags.has("chat")) continue;
    const info = metadata && tags ? modelInfo(id, tags, metadata) : undefined;
    if (!kept.has(id) || (info && !kept.get(id))) kept.set(id, info);
  }
  return {
    models: [...kept.keys()],
    details: [...kept.values()].filter((info) => info !== undefined),
  };
}
