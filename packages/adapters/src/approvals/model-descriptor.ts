import type { DecisionProvider, DecisionProviderOptions } from "@rakazo/adapter-kit";
import type { ModelCatalogEntry } from "@rakazo/contracts";

/** How a decision model's `confidence` relates to p, the probability of the answer it chose. */
export interface DecisionCalibration {
  /** `linear`: confidence is 2p - 1. */
  confidenceScale: "linear";
  /** The p a pass needs before the action runs without asking, tuned for this model. */
  minPassProbability: number;
}

/** Provider-owned decision protocol identifiers, pricing provenance and calibration. */
export interface DecisionModelDescriptor {
  provider: string;
  id: string;
  aliases?: readonly string[];
  inputUsdPerMillion: number;
  pricingVersion: string;
  pricingUrl: string;
  calibration: DecisionCalibration;
  catalog?: ModelCatalogEntry;
  create: (options: DecisionProviderOptions) => DecisionProvider;
  deploymentApiKey: (env: NodeJS.ProcessEnv) => string | undefined;
  /** Whether its host can keep requests to endpoints that retain no prompts. */
  dataRetentionControl?: true;
  includedByDefault?: boolean;
}
