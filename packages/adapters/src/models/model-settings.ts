import type { ModelSettings } from "@rakazo/contracts";
import { DEFAULT_MODEL_MAX_TOKENS, withModelDefaults } from "@rakazo/contracts";
import { REASONING_MODEL_MAX_TOKENS } from "../runtime/pi/pi-runtime-limits.js";
import { isPrivateOpenAiCompatibleHostname } from "./endpoints/openai-compatible-url.js";
import type { StoredModelSecret } from "./model-secret.js";
import { catalogKnowsModel, compatibleModelSeesImages } from "./model-vision.js";

type LegacyCredential = { supportsImages?: boolean | null; defaultModel?: string | null };

/**
 * The settings a model on this connection runs with. A model's own saved settings replace
 * everything; until it has some, values saved for the whole connection still apply to it.
 * Image input and thinking, with its level, stay the catalog's answer for models it knows.
 * A compatible model fills what is left from `compatibleModelDefaults`.
 */
export function connectionModelSettings(
  secret: StoredModelSecret,
  provider: string,
  modelId: string,
  credential?: LegacyCredential,
): ModelSettings {
  const settings = savedModelSettings(secret, modelId, credential);
  if (!catalogKnowsModel(provider, modelId)) {
    if (secret.kind !== "openai_compatible") return settings;
    const merged = withModelDefaults(compatibleModelDefaults(secret, modelId), settings);
    // The list names the model's ceiling; a request asks for the usual modest share of it.
    if (settings.maxTokens === undefined && merged.maxTokens !== undefined)
      merged.maxTokens = Math.min(
        merged.maxTokens,
        merged.reasoning ? REASONING_MODEL_MAX_TOKENS : DEFAULT_MODEL_MAX_TOKENS,
      );
    return merged;
  }
  const { images: _images, reasoning: _reasoning, thinkingLevel: _level, ...limits } = settings;
  return limits;
}

/**
 * What a compatible model does until its own settings say otherwise: what the server's model
 * list said, else image input and thinking, as most models today have both. A model on a local
 * or private server is assumed to have neither, as small local models often lack them.
 */
export function compatibleModelDefaults(
  secret: Extract<StoredModelSecret, { kind: "openai_compatible" }>,
  modelId: string,
): ModelSettings {
  const listed = secret.listedModels?.[modelId.trim()] ?? {};
  const url = URL.parse(secret.baseUrl);
  if (url && isPrivateOpenAiCompatibleHostname(url.hostname)) return listed;
  return { images: true, reasoning: true, ...listed };
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

/**
 * Store one model's settings on the connection. Empty settings return it to the model card: the
 * entry goes away, unless values saved for the whole connection would apply to it instead.
 */
export function withModelSettings<T extends StoredModelSecret>(
  secret: T,
  modelId: string,
  settings: ModelSettings,
): T {
  const { [modelId.trim()]: _replaced, ...others } = secret.models ?? {};
  const keep = Object.keys(settings).length > 0 || hasConnectionWideSettings(secret);
  const models = keep ? { ...others, [modelId.trim()]: settings } : others;
  return { ...secret, models: Object.keys(models).length > 0 ? models : undefined };
}

function hasConnectionWideSettings(secret: StoredModelSecret): boolean {
  return (
    secret.maxTokens !== undefined ||
    (secret.kind !== "oauth" && secret.contextWindow !== undefined) ||
    (secret.kind === "openai_compatible" &&
      (secret.reasoning !== undefined ||
        secret.maxImagesPerPrompt !== undefined ||
        // Without a per-model list, the connection's earlier image answer can still apply.
        secret.visionModelIds === undefined ||
        secret.visionModelIds.length > 0))
  );
}
