import type { ModelCatalogEntry, UsageBreakdown } from "@rakazo/contracts";
import { canonicalPiProviderId } from "@rakazo/contracts";

type ModelIdentity = UsageBreakdown["modelOptions"][number];
type CatalogName = Pick<ModelCatalogEntry, "provider" | "id" | "label" | "providerName">;

export const usageModelKey = ({ provider, model }: ModelIdentity) =>
  JSON.stringify([provider, model]);

export function usageModelLabels(
  models: ModelIdentity[],
  catalog: readonly CatalogName[],
  fallbackLabel: string,
) {
  const catalogModels = new Map<string, CatalogName>();
  const providerNames = new Map<string, string>();
  for (const entry of catalog) {
    const provider = canonicalPiProviderId(entry.provider);
    const key = usageModelKey({ provider, model: entry.id });
    if (!catalogModels.has(key)) catalogModels.set(key, entry);
    if (entry.providerName && !providerNames.has(provider)) {
      providerNames.set(provider, entry.providerName);
    }
  }
  const labelsFor = ({ provider, model }: ModelIdentity) => {
    const canonical = canonicalPiProviderId(provider);
    const entry = catalogModels.get(usageModelKey({ provider: canonical, model }));
    return {
      modelLabel: entry?.label ?? fallbackLabel,
      providerLabel: entry?.providerName ?? providerNames.get(canonical),
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
