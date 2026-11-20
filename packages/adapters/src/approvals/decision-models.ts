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
  return models.flatMap((model) =>
    model.catalog
      ? [
          {
            ...model.catalog,
            ...(model.dataRetentionControl ? { dataRetentionControl: true as const } : {}),
          },
        ]
      : [],
  );
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

/** Each scale's confidence for a chosen answer of probability p; a new scale must add its own. */
const confidenceAt: Record<DecisionCalibration["confidenceScale"], (p: number) => number> = {
  linear: (p) => 2 * p - 1,
};
/** The inverse of `confidenceAt`: the probability of the chosen answer at a confidence. */
const probabilityAt: Record<DecisionCalibration["confidenceScale"], (c: number) => number> = {
  linear: (c) => (c + 1) / 2,
};

/** The model's probability that the action may pass, from the answer it chose and its confidence. */
export function passProbability(
  calibration: DecisionCalibration,
  choice: "pass" | "ask",
  confidence: number,
): number {
  const chosen = probabilityAt[calibration.confidenceScale](confidence);
  return choice === "pass" ? chosen : 1 - chosen;
}

/** The model's own confidence that matches its pass probability floor, so the gate compares like with like. */
export function passConfidenceFloor(calibration: DecisionCalibration): number {
  const floor = confidenceAt[calibration.confidenceScale](calibration.minPassProbability);
  // Rounded so a model reporting exactly the floor (0.32 for p 0.66) is not lost to float error.
  return Math.round(floor * 1e9) / 1e9;
}
