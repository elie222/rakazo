import type { ModelCatalogEntry } from "@rakazo/contracts";
import { openRouterDecisionModel } from "../providers/decision/openrouter/decision-model.js";
import { typesafeDecisionModel } from "../providers/decision/typesafe/decision-model.js";
import type { DecisionModelDescriptor } from "./model-descriptor.js";

const models: readonly DecisionModelDescriptor[] = [openRouterDecisionModel, typesafeDecisionModel];

export function decisionModel(provider: string, id: string) {
  return models.find(
    (model) => model.provider === provider && (model.id === id || model.aliases?.includes(id)),
  );
}
export function decisionModelCatalog(): ModelCatalogEntry[] {
  return models.flatMap((model) => (model.catalog ? [{ ...model.catalog }] : []));
}

/** Only a single explicitly designated, configured default can supply included checks. */
export function includedDecisionModel(env: NodeJS.ProcessEnv = process.env) {
  const defaults = models.filter((model) => model.includedByDefault && model.deploymentApiKey(env));
  return defaults.length === 1 ? defaults[0] : undefined;
}

export function decisionInputCost(
  pricing: Pick<DecisionModelDescriptor, "inputUsdPerMillion">,
  tokens: number,
) {
  return (tokens * pricing.inputUsdPerMillion) / 1_000_000;
}
