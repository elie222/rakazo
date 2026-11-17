import type { DecisionModelDescriptor } from "../../../decisions/model-descriptor.js";
import { HttpDecisionProvider } from "../../../http-decisions.js";

export const typesafeDecisionModel: DecisionModelDescriptor = {
  create: (options) => new HttpDecisionProvider("typesafe", options),
  deploymentApiKey: (env) => env.TYPESAFE_API_KEY?.trim() || undefined,
  provider: "typesafe",
  id: "jev-1.14",
  aliases: ["jev-latest"],
  inputUsdPerMillion: 0.042,
  pricingVersion: "decision-pricing-2026-11-17",
  pricingUrl: "https://help.typesafe.ai/articles/5187202169-how-much-does-jev-cost",
};
