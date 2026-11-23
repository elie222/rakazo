import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import { canonicalPiProviderId } from "@rakazo/contracts";

/** Apply provider protocol capabilities before catalog and runtime selection. */
export function applyPiModelCompatibility(models: MutableModels): MutableModels {
  // Pi's catalog maps some Gemini levels to efforts its Google request builder rejects
  // ("Unsupported Google thinking level mapping"), so those levels clamp to a supported one.
  for (const provider of models.getProviders?.() ?? []) {
    const original = provider.getModels();
    if (!original.some(hasUnsendableGoogleLevel)) continue;
    const sendable = original.map((model) =>
      hasUnsendableGoogleLevel(model)
        ? {
            ...model,
            thinkingLevelMap: Object.fromEntries(
              Object.entries(model.thinkingLevelMap ?? {}).map(([level, effort]) => [
                level,
                isSendableGoogleEffort(effort) ? effort : null,
              ]),
            ),
          }
        : model,
    );
    models.setProvider({ ...provider, getModels: () => sendable });
  }
  const provider = models.getProvider?.("amazon-bedrock");
  if (provider) {
    const guardedId = "in.anthropic.claude-haiku-4-5-20251001-v1:0";
    const guardedModels = provider
      .getModels()
      .map((model) =>
        model.id === guardedId
          ? { ...model, compat: { ...model.compat, supportsStrictMode: false } }
          : model,
      );
    models.setProvider({ ...provider, getModels: () => guardedModels });
  }
  // Only OpenAI's own endpoints, and OpenRouter (which translates per model), accept the
  // developer role. Other chat templates know system/user/assistant/tool and reject the
  // whole request ("Unexpected message role") when a reasoning model sends developer.
  for (const compatible of models.getProviders?.() ?? []) {
    if (DEVELOPER_ROLE_PROVIDERS.has(compatible.id)) continue;
    const original = compatible.getModels();
    if (!original.some(defaultsToDeveloperRole)) continue;
    const systemModels = original.map((model) =>
      defaultsToDeveloperRole(model)
        ? { ...model, compat: { ...model.compat, supportsDeveloperRole: false } }
        : model,
    );
    models.setProvider({ ...compatible, getModels: () => systemModels });
  }
  const getModel = models.getModel.bind(models);
  models.getModel = (provider, id) => getModel(canonicalPiProviderId(provider), id);
  const getProvider = models.getProvider?.bind(models);
  if (getProvider) models.getProvider = (provider) => getProvider(canonicalPiProviderId(provider));
  return models;
}

const DEVELOPER_ROLE_PROVIDERS = new Set(["openai", "azure", "openrouter"]);

/** A reasoning chat-completions model that pi would send the developer role by default. */
function defaultsToDeveloperRole(model: Model<Api>): boolean {
  if (model.api !== "openai-completions" || !model.reasoning) return false;
  const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
  return compat?.supportsDeveloperRole === undefined;
}

const GOOGLE_APIS = new Set(["google-generative-ai", "google-vertex"]);
const GOOGLE_EFFORTS = new Set(["minimal", "low", "medium", "high"]);

function isSendableGoogleEffort(effort: string | null | undefined): boolean {
  return typeof effort !== "string" || GOOGLE_EFFORTS.has(effort.toLowerCase());
}

function hasUnsendableGoogleLevel(model: Model<Api>): boolean {
  return (
    GOOGLE_APIS.has(model.api) &&
    Object.values(model.thinkingLevelMap ?? {}).some((effort) => !isSendableGoogleEffort(effort))
  );
}
