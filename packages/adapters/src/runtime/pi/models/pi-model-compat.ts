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
  const bedrockModelsByBase = new Map<string, Model<Api>>();
  if (provider) {
    const guardedId = "in.anthropic.claude-haiku-4-5-20251001-v1:0";
    const providerCostByVendorSlug = new Map<string, Model<Api>["cost"]>();
    for (const candidateProvider of models.getProviders?.() ?? []) {
      if (candidateProvider.id === "amazon-bedrock") continue;
      for (const candidate of candidateProvider.getModels()) {
        if (!hasPositiveCost(candidate.cost)) continue;
        const key = `${candidateProvider.id}:${stripModelVersion(candidate.id.toLowerCase())}`;
        if (!providerCostByVendorSlug.has(key)) providerCostByVendorSlug.set(key, candidate.cost);
      }
    }
    const rawBedrockModels = provider.getModels();
    const bedrockCostByBase = new Map<string, Model<Api>["cost"]>();
    for (const model of rawBedrockModels) {
      if (!hasPositiveCost(model.cost)) continue;
      const base = bedrockBaseModelId(model.id);
      if (!bedrockCostByBase.has(base)) bedrockCostByBase.set(base, model.cost);
    }
    const guardedModels = rawBedrockModels.map((model) => {
      const withGuard =
        model.id === guardedId
          ? { ...model, compat: { ...model.compat, supportsStrictMode: false } }
          : model;
      if (hasPositiveCost(withGuard.cost)) return withGuard;
      const base = bedrockBaseModelId(withGuard.id);
      const fallbackCost =
        bedrockCostByBase.get(base) ?? vendorCostForBedrockBase(base, providerCostByVendorSlug);
      return fallbackCost ? { ...withGuard, cost: fallbackCost } : withGuard;
    });
    for (const model of guardedModels) {
      const base = bedrockBaseModelId(model.id);
      const existing = bedrockModelsByBase.get(base);
      if (!existing || (!hasPositiveCost(existing.cost) && hasPositiveCost(model.cost))) {
        bedrockModelsByBase.set(base, model);
      }
    }
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
  models.getModel = (providerId, id) => {
    const canonical = canonicalPiProviderId(providerId);
    const exact = getModel(canonical, id);
    if (exact) return exact;
    if (canonical === "amazon-bedrock" && id) {
      const sibling = bedrockModelsByBase.get(bedrockBaseModelId(id));
      if (sibling) {
        return {
          ...sibling,
          id,
          compat:
            id === "in.anthropic.claude-haiku-4-5-20251001-v1:0"
              ? { ...sibling.compat, supportsStrictMode: false }
              : sibling.compat,
        };
      }
    }
    return undefined;
  };
  const getProvider = models.getProvider?.bind(models);
  if (getProvider)
    models.getProvider = (providerId) => getProvider(canonicalPiProviderId(providerId));
  return models;
}

const BEDROCK_REGION_PREFIX = /^(?:global|us|eu|ap|au|in|jp|ca|sa)\./;

function stripModelVersion(id: string): string {
  return id.replace(/(?:-v\d+)?(?::\d+)?$/, "");
}

function bedrockBaseModelId(id: string): string {
  return stripModelVersion(id.trim().toLowerCase().replace(BEDROCK_REGION_PREFIX, ""));
}

function hasPositiveCost(cost: Model<Api>["cost"] | undefined): boolean {
  if (!cost) return false;
  return [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].some((rate) => rate > 0);
}

function vendorCostForBedrockBase(
  base: string,
  providerCostByVendorSlug: ReadonlyMap<string, Model<Api>["cost"]>,
): Model<Api>["cost"] | undefined {
  const dot = base.indexOf(".");
  if (dot <= 0) return undefined;
  const vendor = base.slice(0, dot);
  const slug = base.slice(dot + 1);
  return providerCostByVendorSlug.get(`${vendor}:${slug}`);
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
