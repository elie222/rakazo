import type { ModelCatalogEntry } from "@rakazo/contracts";
import type { DecisionModelDescriptor } from "./decisions/model-descriptor.js";
import { openRouterDecisionModel } from "./providers/decision/openrouter/decision-model.js";
import { typesafeDecisionModel } from "./providers/decision/typesafe/decision-model.js";

const models: readonly DecisionModelDescriptor[] = [openRouterDecisionModel, typesafeDecisionModel];

export function decisionModel(provider: string, id: string) {
  return models.find(
    (model) => model.provider === provider && (model.id === id || model.aliases?.includes(id)),
  );
}
export function decisionModelCatalog(): ModelCatalogEntry[] {
  return models.flatMap((model) => (model.catalog ? [{ ...model.catalog }] : []));
}
