import type { DecisionProviderOptions } from "@rakazo/adapter-kit";
import { DEFAULT_JEV_MODEL } from "../../../approvals/auto-review.js";
import { AutoReviewSetupError } from "../../../approvals/auto-review-failures.js";
import { DecisionAutoReviewProvider } from "../../../approvals/decision-auto-review.js";
import { HttpDecisionProvider } from "../../../approvals/http-decisions.js";

export interface JevAutoReviewOptions extends DecisionProviderOptions {
  timeoutMs?: number;
  model?: string;
  minConfidence?: number;
}
/** Compatibility entry point for existing self-hosted TypeSafe configuration. */
export class JevAutoReviewProvider extends DecisionAutoReviewProvider {
  constructor(options: JevAutoReviewOptions) {
    if (!options.apiKey.trim()) throw new AutoReviewSetupError("TYPESAFE_API_KEY is required");
    super({
      ...options,
      provider: new HttpDecisionProvider("typesafe", options),
      providerId: "jev",
      model: options.model?.trim() || DEFAULT_JEV_MODEL,
    });
  }
}
