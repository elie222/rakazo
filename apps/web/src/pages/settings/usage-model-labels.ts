import type { ModelCatalogEntry, UsageBreakdown } from "@rakazo/contracts";
import { canonicalPiProviderId } from "@rakazo/contracts";

type ModelIdentity = UsageBreakdown["modelOptions"][number];
type CatalogName = Pick<ModelCatalogEntry, "provider" | "id" | "label" | "providerName">;

export const usageModelKey = ({ provider, model }: ModelIdentity) =>
  JSON.stringify([provider, model]);

const GATEWAY_MODEL_PREFIX = /^(?:bedrock|vertex|azure|openai|anthropic|google)\//;
const REGIONAL_MODEL_PREFIX = /^(?:global|us|eu|ap|au|in|jp|ca|sa)\./;
const BEDROCK_VENDOR_PREFIX =
  /^(?:anthropic|amazon|meta|mistral|cohere|deepseek|openai|ai21|stability|writer|twelvelabs|qwen)\./;

function normalizedModelSlug(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(GATEWAY_MODEL_PREFIX, "")
    .replace(REGIONAL_MODEL_PREFIX, "")
    .replace(BEDROCK_VENDOR_PREFIX, "")
    .replace(/(?:-v\d+)?(?::\d+)?$/, "");
}

function recordUniqueSlug(map: Map<string, CatalogName | null>, key: string, entry: CatalogName) {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, entry);
  } else if (existing !== null && existing.label !== entry.label) {
    map.set(key, null);
  }
}

export function usageModelLabels(
  models: ModelIdentity[],
  catalog: readonly CatalogName[],
  fallbackLabel: string,
) {
  const catalogModels = new Map<string, CatalogName>();
  const providerSlugs = new Map<string, CatalogName | null>();
  const globalSlugs = new Map<string, CatalogName | null>();
  const providerNames = new Map<string, string>();
  for (const entry of catalog) {
    const provider = canonicalPiProviderId(entry.provider);
    const key = usageModelKey({ provider, model: entry.id });
    if (!catalogModels.has(key)) catalogModels.set(key, entry);
    const slug = normalizedModelSlug(entry.id);
    if (slug) {
      const providerSlugKey = `${provider}\0${slug}`;
      recordUniqueSlug(providerSlugs, providerSlugKey, entry);
      recordUniqueSlug(globalSlugs, slug, entry);
    }
    if (entry.providerName && !providerNames.has(provider)) {
      providerNames.set(provider, entry.providerName);
    }
  }
  const labelsFor = ({ provider, model }: ModelIdentity) => {
    const canonical = canonicalPiProviderId(provider);
    let entry = catalogModels.get(usageModelKey({ provider: canonical, model }));
    let matchedCrossProvider = false;
    if (!entry) {
      const slug = normalizedModelSlug(model);
      if (slug && slug !== model.trim().toLowerCase()) {
        entry = providerSlugs.get(`${canonical}\0${slug}`) ?? undefined;
        if (!entry) {
          entry = globalSlugs.get(slug) ?? undefined;
          matchedCrossProvider = Boolean(entry);
        }
      }
    }
    return {
      modelLabel: entry?.label ?? fallbackLabel,
      providerLabel: matchedCrossProvider
        ? providerNames.get(canonical)
        : (entry?.providerName ?? providerNames.get(canonical)),
    };
  };
  const names = models.map((model) => ({ key: usageModelKey(model), ...labelsFor(model) }));
  const labelCounts = new Map<string, number>();
  for (const model of names) {
    labelCounts.set(model.modelLabel, (labelCounts.get(model.modelLabel) ?? 0) + 1);
  }
  const candidates = names.map((model) => {
    const sharedName = (labelCounts.get(model.modelLabel) ?? 0) > 1;
    return {
      key: model.key,
      label:
        sharedName && model.providerLabel
          ? `${model.modelLabel} (${model.providerLabel})`
          : model.modelLabel,
      providerLabel: sharedName ? undefined : model.providerLabel,
    };
  });
  const needsReferences = new Set(candidates.map((model) => model.label)).size < candidates.length;
  const references = new Map(
    candidates
      .map((model) => model.key)
      .sort()
      .map((key, index) => [key, index + 1]),
  );
  const options = candidates.map((model) => ({
    ...model,
    label: needsReferences ? `${references.get(model.key)}. ${model.label}` : model.label,
  }));
  return { options, byKey: new Map(options.map((model) => [model.key, model])), labelsFor };
}
