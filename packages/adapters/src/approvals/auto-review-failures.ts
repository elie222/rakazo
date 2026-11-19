import {
  DecisionProviderError,
  SecretNotFoundError,
  SecretStoreUnavailableError,
} from "@rakazo/adapter-kit";
import { ContentDecryptionError } from "@rakazo/db";
import { ModelCreditConnectionUnavailableError } from "../model-credits/routing.js";
import {
  HostedModelCreditsRequiredError,
  ModelCreditAccountUnavailableError,
} from "../models/credits/model-credit-observer.js";
import {
  ModelConnectionGoneError,
  UnavailableModelForAuthError,
} from "../models/model-selection.js";
import { RetiredModelCredentialError } from "../runtime/pi/models/pi-oauth.js";
import { isPermanentDecryptFailure } from "../secrets/secrets.js";

/** The reviewer a member or backup chose has no connection and no credits to run on. */
export class CheckerConnectionUnavailableError extends Error {
  constructor() {
    super("Selected checker connection is unavailable");
    this.name = "CheckerConnectionUnavailableError";
  }
}

/** The deployment's reviewer kind cannot be built: a missing verifier key or an unknown kind. */
export class AutoReviewSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoReviewSetupError";
  }
}

export type AutoReviewFailureCode =
  | "credits_required"
  | "connection_unavailable"
  | "model_unavailable"
  | "decision_auth"
  | "provider_construction"
  | "decrypt"
  | "unexpected";

/** What a card and its audit show for a reviewer that could not run. */
export const AUTO_REVIEW_FAILURE_REASONS: Record<AutoReviewFailureCode, string> = {
  credits_required: "Checker needs model credits.",
  connection_unavailable: "Checker connection is unavailable.",
  model_unavailable: "Checker model is unavailable.",
  decision_auth: "Checker could not authenticate.",
  provider_construction: "Checker is not set up.",
  decrypt: "Checker connection could not be read.",
  unexpected: "Checker could not complete the review.",
};

export function autoReviewFailureCode(error: unknown): AutoReviewFailureCode {
  if (
    error instanceof HostedModelCreditsRequiredError ||
    error instanceof ModelCreditAccountUnavailableError
  )
    return "credits_required";
  if (
    error instanceof CheckerConnectionUnavailableError ||
    error instanceof ModelConnectionGoneError ||
    error instanceof RetiredModelCredentialError ||
    error instanceof ModelCreditConnectionUnavailableError
  )
    return "connection_unavailable";
  if (error instanceof UnavailableModelForAuthError) return "model_unavailable";
  if (error instanceof DecisionProviderError)
    return error.kind === "authentication" ? "decision_auth" : "provider_construction";
  if (error instanceof AutoReviewSetupError) return "provider_construction";
  if (
    error instanceof ContentDecryptionError ||
    error instanceof SecretStoreUnavailableError ||
    error instanceof SecretNotFoundError ||
    isPermanentDecryptFailure(error)
  )
    return "decrypt";
  return "unexpected";
}
