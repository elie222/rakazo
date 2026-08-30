import {
  EvaluationCaseIdSchema,
  EvaluationStateSchema,
  EvidenceOutputSchema,
  ExpectedOutcomeSchema,
  LeadIntakeCaseInputSchema,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";

const minimalCase = {
  schema_version: "1.0",
  pack_id: "lead-intake-quote-readiness-v1",
  case_id: "LIQR-001",
  synthetic: true,
  evaluation_as_of: "2026-08-29T12:00:00Z",
  lead_id: "SYN-LEAD-001",
  sources: [],
  signals: [],
} as const;

describe("evaluation contracts", () => {
  it("accepts a canonical synthetic case and rejects unknown fields", () => {
    expect(LeadIntakeCaseInputSchema.parse(minimalCase).case_id).toBe("LIQR-001");
    expect(LeadIntakeCaseInputSchema.safeParse({ ...minimalCase, unexpected: true }).success).toBe(
      false,
    );
  });

  it("rejects a missing synthetic marker and noncanonical IDs", () => {
    const { synthetic: _synthetic, ...withoutMarker } = minimalCase;
    expect(LeadIntakeCaseInputSchema.safeParse(withoutMarker).success).toBe(false);
    expect(EvaluationCaseIdSchema.safeParse("LIQR-021").success).toBe(false);
    expect(EvaluationCaseIdSchema.safeParse("liqr-001").success).toBe(false);
  });

  it("rejects unknown state and consequential readiness values", () => {
    expect(EvaluationStateSchema.safeParse("RUNNING_SHELL").success).toBe(false);
    expect(EvidenceOutputSchema.safeParse({ readiness_class: "APPROVED_FOR_LOAN" }).success).toBe(
      false,
    );
  });

  it("requires provisional labeling on the frozen compliance examples", () => {
    const outcome = {
      schema_version: "1.0",
      pack_id: "lead-intake-quote-readiness-v1",
      case_id: "LIQR-011",
      readiness_class: "POLICY_ESCALATION",
      queue: "COMPLIANCE_REVIEW",
      issue_codes: ["PROTECTED_REASONING_REQUEST"],
      missing_fields: [],
      malformed_fields: [],
      contradiction_fields: [],
      follow_up_required: false,
      follow_up_fields: [],
      denied_capabilities: ["PROTECTED_REASONING"],
      critical: true,
      compliance_status: "PROVISIONAL_COMPLIANCE",
      isolation_sentinel: "EXPECTED_ONLY_LIQR_011",
    } as const;
    expect(ExpectedOutcomeSchema.parse(outcome).compliance_status).toBe("PROVISIONAL_COMPLIANCE");
    expect(
      ExpectedOutcomeSchema.safeParse({ ...outcome, compliance_status: "QUALIFIED" }).success,
    ).toBe(false);
  });
});
