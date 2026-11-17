import type { DecisionModelDescriptor } from "../../../decision-model-descriptor.js";

export const openRouterDecisionModel: DecisionModelDescriptor = {
  provider: "openrouter",
  id: "typesafe/jev-1.14",
  inputUsdPerMillion: 0.042,
  pricingVersion: "decision-pricing-2026-11-17",
  pricingUrl: "https://openrouter.ai/typesafe/jev-1.14",
  catalog: {
    provider: "openrouter",
    providerName: "OpenRouter",
    id: "typesafe/jev-1.14",
    label: "Jev 1.14",
    protocol: "decisions",
    billing: "Uses your API key",
    auth: "api-key",
  },
};
