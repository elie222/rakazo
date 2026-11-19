import type { ModelCatalogEntry } from "@rakazo/contracts";
import {
  openRouterDecisionModel,
  openRouterMicrosoftDecisionModel,
} from "../providers/decision/openrouter/decision-model.js";
import { typesafeDecisionModel } from "../providers/decision/typesafe/decision-model.js";
import type { DecisionCalibration, DecisionModelDescriptor } from "./model-descriptor.js";

const models: readonly DecisionModelDescriptor[] = [
  openRouterDecisionModel,
  openRouterMicrosoftDecisionModel,
  typesafeDecisionModel,
];

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

/** The model's own confidence that matches its pass probability floor, so the gate compares like with like. */
export function passConfidenceFloor(calibration: DecisionCalibration): number {
  return 2 * calibration.minPassProbability - 1;
}
