import type { ModelCatalogEntry } from "@rakazo/contracts";

/** Protocol/pricing belongs to the adapter catalog, never approval policy. */
const models = [
  { provider: "openrouter", id: "typesafe/jev-1.14", label: "Jev 1.14", inputUsdPerMillion: 0.042 },
];
export function decisionModel(provider: string, id: string) {
  const model =
    models.find((model) => model.provider === provider && model.id === id) ??
    (provider === "typesafe" && (id === "jev-latest" || id === "jev-1.14") ? models[0] : undefined);
  return model
    ? {
        ...model,
        pricingVersion: "decision-pricing-2026-11-17",
        pricingUrl:
          provider === "typesafe"
            ? "https://help.typesafe.ai/articles/5187202169-how-much-does-jev-cost"
            : "https://openrouter.ai/typesafe/jev-1.14",
      }
    : undefined;
}
export function decisionModelCatalog(): ModelCatalogEntry[] {
  return models.map((model) => ({
    provider: model.provider,
    providerName: "OpenRouter",
    id: model.id,
    label: model.label,
    protocol: "decisions",
    billing: "Uses your API key",
    auth: "api-key",
  }));
}
