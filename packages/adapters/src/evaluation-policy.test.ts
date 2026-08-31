import {
  EVALUATION_ALLOWED_TOOL_IDS,
  EVALUATION_DEFAULT_BUDGET,
  EVALUATION_PACK_ID,
  type EvaluationRunPolicy,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { computeEvaluationPolicyHash, validateEvaluationPreflight } from "./evaluation-policy.js";

function policy(overrides: Partial<EvaluationRunPolicy> = {}): EvaluationRunPolicy {
  const unsigned: Omit<EvaluationRunPolicy, "policy_hash"> = {
    kind: "evaluation_pack_v1",
    pack_id: EVALUATION_PACK_ID,
    campaign_id: "campaign-01",
    case_id: "LIQR-001",
    run_id: "run-01",
    user_id: "user-01",
    workspace_id: "workspace-01",
    allowed_tool_ids: [...EVALUATION_ALLOWED_TOOL_IDS],
    evidence_root: "evaluations/lead-intake-quote-readiness-v1/campaign-01/LIQR-001/run-01",
    budgets: { ...EVALUATION_DEFAULT_BUDGET },
    issued_at: "2026-08-29T00:00:00.000Z",
    expires_at: "2026-08-30T00:00:00.000Z",
    revoked_at: null,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "policy_hash")),
  } as Omit<EvaluationRunPolicy, "policy_hash">;
  return {
    ...unsigned,
    policy_hash: overrides.policy_hash ?? computeEvaluationPolicyHash(unsigned),
  };
}

const identity = {
  runId: "run-01",
  workspaceId: "workspace-01",
  userId: "user-01",
  campaignId: "campaign-01",
  caseId: "LIQR-001",
};

describe("evaluation policy preflight", () => {
  it("accepts only an enabled, valid, bound and unexpired policy", () => {
    const candidate = policy();
    expect(
      validateEvaluationPreflight({
        featureEnabled: true,
        policy: candidate,
        identity: { ...identity, policyHash: candidate.policy_hash },
        now: new Date("2026-08-29T12:00:00.000Z"),
      }),
    ).toMatchObject({ ok: true });
  });

  it.each([
    ["feature flag", { featureEnabled: false }, "FEATURE_DISABLED"],
    ["run", { identity: { ...identity, runId: "wrong" } }, "RUN_MISMATCH"],
    ["workspace", { identity: { ...identity, workspaceId: "wrong" } }, "WORKSPACE_MISMATCH"],
    ["user", { identity: { ...identity, userId: "wrong" } }, "USER_MISMATCH"],
    ["campaign", { identity: { ...identity, campaignId: "wrong" } }, "CAMPAIGN_MISMATCH"],
    ["case", { identity: { ...identity, caseId: "LIQR-002" } }, "CASE_MISMATCH"],
  ])("denies a %s mismatch", (_label, change, reason) => {
    const candidate = policy();
    const changedIdentity = "identity" in change ? change.identity : identity;
    expect(
      validateEvaluationPreflight({
        featureEnabled: "featureEnabled" in change ? change.featureEnabled : true,
        policy: candidate,
        identity: { ...changedIdentity, policyHash: candidate.policy_hash },
        now: new Date("2026-08-29T12:00:00.000Z"),
      }),
    ).toEqual({ ok: false, reason });
  });

  it("denies expiry, revocation and mutated policy material", () => {
    const candidate = policy();
    const base = { ...identity, policyHash: candidate.policy_hash };
    expect(
      validateEvaluationPreflight({
        featureEnabled: true,
        policy: candidate,
        identity: base,
        now: new Date(candidate.expires_at),
      }),
    ).toEqual({ ok: false, reason: "POLICY_EXPIRED" });
    const revoked = policy({ revoked_at: "2026-08-29T11:00:00.000Z" });
    expect(
      validateEvaluationPreflight({
        featureEnabled: true,
        policy: revoked,
        identity: { ...identity, policyHash: revoked.policy_hash },
        now: new Date("2026-08-29T12:00:00.000Z"),
      }),
    ).toEqual({ ok: false, reason: "POLICY_REVOKED" });
    expect(
      validateEvaluationPreflight({
        featureEnabled: true,
        policy: { ...candidate, evidence_root: `${candidate.evidence_root}-mutated` },
        identity: base,
        now: new Date("2026-08-29T12:00:00.000Z"),
      }),
    ).toEqual({ ok: false, reason: "POLICY_HASH_INVALID" });
  });
});
