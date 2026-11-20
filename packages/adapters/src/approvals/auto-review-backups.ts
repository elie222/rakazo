import type { AutoReviewResult } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import type { AutoReviewChecker } from "./auto-review.js";
import { AUTO_REVIEW_FAILURE_REASONS, autoReviewFailureCode } from "./auto-review-failures.js";

/** Whose choice a reviewer is: the deployment's, the member's own, or one of their backups. */
export type AutoReviewCheckerRole = "default" | "member" | "backup";

export type AutoReviewCandidate = AutoReviewChecker & { role: AutoReviewCheckerRole };

/** A deliberate ask is final. Only unavailable checkers advance to an ordered backup. */
export async function reviewWithBackups(
  candidates: AutoReviewCandidate[],
  review: (candidate: AutoReviewCandidate) => Promise<AutoReviewResult>,
  signal: AbortSignal,
): Promise<AutoReviewResult> {
  let result: AutoReviewResult = {
    decision: "error",
    model: "unavailable",
    reason: AUTO_REVIEW_FAILURE_REASONS.unexpected,
  };
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (signal.aborted) break;
    const key = JSON.stringify([
      candidate.provider,
      candidate.model,
      candidate.credentialId ?? null,
      candidate.creditOfferingId ?? null,
      candidate.included ?? false,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    const earlier = seen.size > 1 ? result : undefined;
    try {
      result = await review(candidate);
    } catch (error) {
      // A cancelled run is not a checker failure.
      if (signal.aborted) break;
      const code = autoReviewFailureCode(error);
      // Only the cause: ids, messages and the reviewed action stay out of logs.
      getLogger().warn("auto_review.checker_failed", {
        "auto_review.reason": code,
        "auto_review.provider": candidate.provider,
        "auto_review.role": candidate.included ? "included" : candidate.role,
        "error.name": error instanceof Error ? error.name : typeof error,
      });
      result = {
        decision: "error",
        model: `${candidate.provider}/${candidate.model}`,
        reason: AUTO_REVIEW_FAILURE_REASONS[code],
      };
    }
    if (result.decision !== "error") return result;
    // The owner can act on why their own choice failed, not on why the fallback did.
    if (candidate.included && earlier) result = earlier;
  }
  return result;
}
