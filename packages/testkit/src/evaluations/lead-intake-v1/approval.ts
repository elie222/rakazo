import {
  type EvaluationApprovalAction,
  type EvaluationApprovalReceipt,
  EvaluationApprovalReceiptSchema,
} from "@rakazo/contracts";

/**
 * Approval-gate binding for Plan 04 item 1 ("Freeze the candidate and corpus").
 *
 * Deliberately reuses `EvaluationApprovalReceiptSchema` from `@rakazo/contracts`
 * rather than inventing a parallel structure — Plan 01 already froze that schema
 * for exactly this purpose. This module only adds the binding check: does a
 * receipt actually authorize the artifact/policy in front of us, right now.
 *
 * It does not replace `SOLO-OPERATOR-APPROVAL-20260829.md`, which is the actual
 * record of what the operator approved and why. This is the mechanical half:
 * given a receipt, can its claim be verified against real hashes and a real
 * clock — the same "evidence, not assertion" rule the rest of this pack follows.
 */

export interface ApprovalBindingCheck {
  receipt: EvaluationApprovalReceipt;
  expectedArtifactHash: string;
  expectedPolicyHash: string;
  now?: Date;
}

export type ApprovalBindingFailureReason =
  | "NOT_APPROVED"
  | "ARTIFACT_HASH_MISMATCH"
  | "POLICY_HASH_MISMATCH"
  | "NOT_YET_VALID"
  | "EXPIRED";

export type ApprovalBindingResult =
  | { valid: true }
  | { valid: false; reason: ApprovalBindingFailureReason; detail: string };

export function verifyApprovalBinding(check: ApprovalBindingCheck): ApprovalBindingResult {
  const receipt = EvaluationApprovalReceiptSchema.parse(check.receipt);
  const now = check.now ?? new Date();

  if (receipt.decision !== "APPROVE") {
    return { valid: false, reason: "NOT_APPROVED", detail: `decision was ${receipt.decision}` };
  }
  if (receipt.artifact_hash !== check.expectedArtifactHash) {
    return {
      valid: false,
      reason: "ARTIFACT_HASH_MISMATCH",
      detail: `receipt binds ${receipt.artifact_hash}, expected ${check.expectedArtifactHash}`,
    };
  }
  if (receipt.policy_hash !== check.expectedPolicyHash) {
    return {
      valid: false,
      reason: "POLICY_HASH_MISMATCH",
      detail: `receipt binds ${receipt.policy_hash}, expected ${check.expectedPolicyHash}`,
    };
  }
  if (now < new Date(receipt.issued_at)) {
    return {
      valid: false,
      reason: "NOT_YET_VALID",
      detail: `issued_at ${receipt.issued_at} is in the future`,
    };
  }
  if (now > new Date(receipt.expires_at)) {
    return {
      valid: false,
      reason: "EXPIRED",
      detail: `expires_at ${receipt.expires_at} has passed`,
    };
  }
  return { valid: true };
}

export function isCorpusFreezeAction(action: EvaluationApprovalAction): boolean {
  return action === "CORPUS_FREEZE";
}

export function isCandidateActivationAction(action: EvaluationApprovalAction): boolean {
  return action === "CANDIDATE_ACTIVATION";
}
