import type { ModelSettings } from "@rakazo/contracts";
import type { StoredModelSecret } from "./model-secret.js";
import { catalogKnowsModel, compatibleModelSeesImages } from "./model-vision.js";

type LegacyCredential = { supportsImages?: boolean | null; defaultModel?: string | null };

/**
 * The settings a model on this connection runs with. A model's own saved settings replace
 * everything; until it has some, values saved for the whole connection still apply to it.
 * Image input and thinking stay the catalog's answer for models it knows.
 */
export function connectionModelSettings(
  secret: StoredModelSecret,
  provider: string,
  modelId: string,
  credential?: LegacyCredential,
): ModelSettings {
  const settings = savedModelSettings(secret, modelId, credential);
  if (!catalogKnowsModel(provider, modelId)) return settings;
  const { images: _images, reasoning: _reasoning, ...limits } = settings;
  return limits;
}

function savedModelSettings(
  secret: StoredModelSecret,
  modelId: string,
  credential?: LegacyCredential,
): ModelSettings {
  const own = secret.models?.[modelId.trim()];
  if (own) return own;
  const settings: ModelSettings = {};
  if (secret.maxTokens !== undefined) settings.maxTokens = secret.maxTokens;
  if (secret.kind !== "oauth" && secret.contextWindow !== undefined)
    settings.contextWindow = secret.contextWindow;
  if (secret.kind === "openai_compatible") {
    if (secret.reasoning !== undefined) settings.reasoning = secret.reasoning;
    if (compatibleModelSeesImages(credential ?? {}, secret, modelId)) settings.images = true;
    if (secret.maxImagesPerPrompt !== undefined)
      settings.maxImagesPerPrompt = secret.maxImagesPerPrompt;
  }
  return settings;
}

/** Store one model's settings on the connection; empty settings return it to the model card. */
export function withModelSettings<T extends StoredModelSecret>(
  secret: T,
  modelId: string,
  settings: ModelSettings,
): T {
  const { [modelId.trim()]: _replaced, ...others } = secret.models ?? {};
  const models =
    Object.keys(settings).length > 0 ? { ...others, [modelId.trim()]: settings } : others;
  return { ...secret, models: Object.keys(models).length > 0 ? models : undefined };
}
