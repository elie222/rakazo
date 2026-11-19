import { HttpDecisionProvider } from "../../../approvals/http-decisions.js";
import type { DecisionModelDescriptor } from "../../../approvals/model-descriptor.js";

const deploymentApiKey = (env: NodeJS.ProcessEnv) => env.OPENROUTER_API_KEY?.trim() || undefined;

export const openRouterDecisionModel: DecisionModelDescriptor = {
  create: (options) => new HttpDecisionProvider("openrouter", options),
  deploymentApiKey,
  includedByDefault: true,
  dataRetentionControl: true,
  provider: "openrouter",
  id: "typesafe/jev-1.14",
  inputUsdPerMillion: 0.042,
  pricingVersion: "decision-pricing-2026-11-17",
  pricingUrl: "https://openrouter.ai/typesafe/jev-1.14",
  calibration: { confidenceScale: "linear", minPassProbability: 0.75 },
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

export const openRouterMicrosoftDecisionModel: DecisionModelDescriptor = {
  create: (options) => new HttpDecisionProvider("openrouter", options),
  deploymentApiKey,
  dataRetentionControl: true,
  provider: "openrouter",
  id: "microsoft/microsoft-decision-1.1",
  inputUsdPerMillion: 0.042,
  pricingVersion: "decision-pricing-2026-11-20",
  pricingUrl: "https://openrouter.ai/microsoft/microsoft-decision-1.1",
  calibration: { confidenceScale: "linear", minPassProbability: 0.66 },
  catalog: {
    provider: "openrouter",
    providerName: "OpenRouter",
    id: "microsoft/microsoft-decision-1.1",
    label: "Microsoft Decision 1.1",
    protocol: "decisions",
    billing: "Uses your API key",
    auth: "api-key",
  },
};
