import type { ModelSettings } from "@rakazo/contracts";
import { ModelSettingsSchema, modelOutputLeavesInputRoom } from "@rakazo/contracts";

/** What a server's model list says one model can do. */
export type ListedModelDetails = Pick<
  ModelSettings,
  "contextWindow" | "maxTokens" | "images" | "reasoning"
>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function tokens(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0,
  );
}

function supported(value: unknown): boolean | undefined {
  const flag = record(value)?.supported;
  return typeof flag === "boolean" ? flag : undefined;
}

function listed(values: unknown, name: string): boolean | undefined {
  return Array.isArray(values) ? values.includes(name) : undefined;
}

/**
 * Reads the fields model lists commonly carry: the capabilities and token limits of the
 * Anthropic-style list, and the modalities and parameters of the OpenRouter-style one. Limits
 * out of range are left out, so the model falls back to its defaults for them.
 */
export function listedModelDetails(entry: unknown): ListedModelDetails {
  const model = record(entry);
  if (!model) return {};
  const capabilities = record(model.capabilities);
  const details: ListedModelDetails = {
    contextWindow: tokens(model.max_input_tokens, model.context_length, model.context_window),
    maxTokens: tokens(
      model.max_tokens,
      model.max_output_tokens,
      record(model.top_provider)?.max_completion_tokens,
    ),
    images:
      supported(capabilities?.image_input) ??
      listed(record(model.architecture)?.input_modalities, "image"),
    reasoning: supported(capabilities?.thinking) ?? listed(model.supported_parameters, "reasoning"),
  };
  // An output limit that leaves no room for input says nothing reliable; the window still does.
  if (!modelOutputLeavesInputRoom(details.maxTokens, details.contextWindow))
    details.maxTokens = undefined;
  const parsed = ModelSettingsSchema.safeParse(details);
  return listedDetails(
    parsed.success ? parsed.data : { images: details.images, reasoning: details.reasoning },
  );
}

/** The fields a model list can describe, without the ones it left out. */
export function listedDetails({
  contextWindow,
  maxTokens,
  images,
  reasoning,
}: ModelSettings): ListedModelDetails {
  return Object.fromEntries(
    Object.entries({ contextWindow, maxTokens, images, reasoning }).filter(
      ([, value]) => value !== undefined,
    ),
  );
}
