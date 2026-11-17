import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import { canonicalPiProviderId } from "@rakazo/contracts";

/** Apply provider protocol capabilities before catalog and runtime selection. */
export function applyPiModelCompatibility(models: MutableModels): MutableModels {
  // Pi 1.5.x predates Hydrogen. Keep this override only until the bundled catalog catches up.
  // https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/4-hydrogen
  for (const id of ["google", "google-vertex"]) {
    const provider = models.getProvider?.(id);
    const sibling = provider?.getModels().find((model) => model.id === "gemini-4-argon");
    if (
      !provider ||
      !sibling ||
      provider.getModels().some((model) => model.id === "gemini-4-hydrogen")
    )
      continue;
    const hydrogen = {
      ...sibling,
      id: "gemini-4-hydrogen",
      name: "Gemini 4 Hydrogen",
      contextWindow: 1_048_576,
      // A single streaming segment; automatic long-decode continuation is not implemented.
      maxTokens: 65_536,
      cost: { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 },
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: null,
      },
    };
    const entries = [...provider.getModels(), hydrogen];
    models.setProvider({ ...provider, getModels: () => entries });
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
