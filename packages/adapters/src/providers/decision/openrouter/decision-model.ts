import { HttpDecisionProvider } from "../../../approvals/http-decisions.js";
import type { DecisionModelDescriptor } from "../../../approvals/model-descriptor.js";

export const openRouterDecisionModel: DecisionModelDescriptor = {
  create: (options) => new HttpDecisionProvider("openrouter", options),
  deploymentApiKey: (env) => env.OPENROUTER_API_KEY?.trim() || undefined,
  includedByDefault: true,
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
