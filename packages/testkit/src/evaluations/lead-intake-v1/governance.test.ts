import type { EvaluationApprovalReceipt } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { verifyApprovalBinding } from "./approval.js";
import { currentPhaseLocalPiInput, evaluateLocalPiPreflight } from "./preflight.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function makeReceipt(
  overrides: Partial<EvaluationApprovalReceipt> = {},
): EvaluationApprovalReceipt {
  return {
    receipt_id: "receipt-1",
    campaign_id: "campaign-1",
    actor_id: "SYN-ACTOR-001",
    action: "CORPUS_FREEZE",
    artifact_hash: HASH_A,
    policy_hash: HASH_B,
    nonce: "nonce-1",
    issued_at: "2026-08-29T00:00:00.000Z",
    expires_at: "2026-12-31T00:00:00.000Z",
    decision: "APPROVE",
    ...overrides,
  };
}

describe("approval binding — Plan 04 item 1", () => {
  it("is valid when the receipt approves and binds the exact expected hashes, within its window", () => {
    const result = verifyApprovalBinding({
      receipt: makeReceipt(),
      expectedArtifactHash: HASH_A,
      expectedPolicyHash: HASH_B,
      now: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a receipt that did not approve", () => {
    const result = verifyApprovalBinding({
      receipt: makeReceipt({ decision: "REJECT" }),
      expectedArtifactHash: HASH_A,
      expectedPolicyHash: HASH_B,
    });
    expect(result).toEqual({ valid: false, reason: "NOT_APPROVED", detail: expect.any(String) });
  });

  it("rejects a receipt bound to a different artifact", () => {
    const result = verifyApprovalBinding({
      receipt: makeReceipt(),
      expectedArtifactHash: "c".repeat(64),
      expectedPolicyHash: HASH_B,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("ARTIFACT_HASH_MISMATCH");
  });

  it("rejects a receipt bound to a different policy", () => {
    const result = verifyApprovalBinding({
      receipt: makeReceipt(),
      expectedArtifactHash: HASH_A,
      expectedPolicyHash: "c".repeat(64),
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("POLICY_HASH_MISMATCH");
  });

  it("rejects an expired receipt", () => {
    const result = verifyApprovalBinding({
      receipt: makeReceipt({ expires_at: "2026-01-01T00:00:00.000Z" }),
      expectedArtifactHash: HASH_A,
      expectedPolicyHash: HASH_B,
      now: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("EXPIRED");
  });

  it("rejects a receipt not yet in its validity window", () => {
    const result = verifyApprovalBinding({
      receipt: makeReceipt({
        issued_at: "2027-01-01T00:00:00.000Z",
        expires_at: "2027-06-01T00:00:00.000Z",
      }),
      expectedArtifactHash: HASH_A,
      expectedPolicyHash: HASH_B,
      now: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("NOT_YET_VALID");
  });
});

describe("local Pi preflight — Plan 04 item 3", () => {
  it("is fail-closed: a single missing precondition blocks authorization", () => {
    const base = currentPhaseLocalPiInput(HASH_A);
    const result = evaluateLocalPiPreflight({
      ...base,
      connectorsDisabled: false,
      phaseAuthorizesLocalPiExecution: true,
    });
    expect(result.authorized).toBe(false);
    expect(result.failures).toContain("CONNECTORS_NOT_DISABLED");
  });

  it("blocks on a policy hash mismatch even when everything else is clean", () => {
    const base = currentPhaseLocalPiInput(HASH_A);
    const result = evaluateLocalPiPreflight({
      ...base,
      approvedPolicyHash: HASH_B,
      phaseAuthorizesLocalPiExecution: true,
    });
    expect(result.authorized).toBe(false);
    expect(result.failures).toEqual(["POLICY_HASH_MISMATCH"]);
  });

  it("blocks on phase authorization alone, even with a perfect environment", () => {
    // This is the actual current state: SOLO-OPERATOR-APPROVAL-20260829.md
    // does not authorize leaving R1, regardless of how clean the environment is.
    const result = evaluateLocalPiPreflight(currentPhaseLocalPiInput(HASH_A));
    expect(result.authorized).toBe(false);
    expect(result.failures).toEqual(["PHASE_DOES_NOT_AUTHORIZE_LOCAL_PI"]);
  });

  it("authorizes only when every precondition, including phase authorization, holds", () => {
    const result = evaluateLocalPiPreflight({
      ...currentPhaseLocalPiInput(HASH_A),
      phaseAuthorizesLocalPiExecution: true,
    });
    expect(result.authorized).toBe(true);
    expect(result.failures).toEqual([]);
  });
});
