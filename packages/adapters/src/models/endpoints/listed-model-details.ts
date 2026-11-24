import type { ModelSettings } from "@rakazo/contracts";
import { ModelSettingsSchema } from "@rakazo/contracts";

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
 * Anthropic-style list, and the modalities and parameters of the OpenRouter-style one. A value
 * out of range is left out, so the model falls back to its defaults for it.
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
  const parsed = ModelSettingsSchema.safeParse(details);
  if (parsed.success) return withoutUndefined(parsed.data);
  const { contextWindow: _window, maxTokens: _tokens, ...capabilityDetails } = details;
  return withoutUndefined(capabilityDetails);
}

function withoutUndefined(details: ListedModelDetails): ListedModelDetails {
  return Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined),
  ) as ListedModelDetails;
}
