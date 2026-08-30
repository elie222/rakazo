import {
  EvaluationCaseIdSchema,
  EvaluationStateSchema,
  EvidenceOutputSchema,
  ExpectedOutcomeSchema,
  LeadIntakeCaseInputSchema,
  type SourceField,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_STATE_TRANSITIONS,
  applyEvaluationTransition,
  canTransitionEvaluationState,
  evaluateLeadIntake,
  getMissingRequiredFields,
  isSourceFresh,
} from "./lead-intake.js";

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

function completeCase() {
  const evaluationAsOf = "2026-08-29T12:00:00Z";
  const source = (field: SourceField, value: string | number | boolean) => ({
    field,
    source_id: `SYN-SOURCE-${field.toUpperCase()}`,
    source_timestamp: evaluationAsOf,
    value,
  });
  return LeadIntakeCaseInputSchema.parse({
    ...minimalCase,
    evaluation_as_of: evaluationAsOf,
    contact_method: { email_token: "SYN_EMAIL_ALPHA" },
    transaction_purpose: "purchase",
    property_use: "primary",
    property_state: "CA",
    estimated_property_value: 500_000,
    requested_loan_amount: 300_000,
    income_summary: "SYN_INCOME_STABLE",
    asset_summary: "SYN_ASSET_STABLE",
    credit_consent_status: "confirmed",
    sources: [
      source("lead_id", "SYN-LEAD-001"),
      source("contact_method", "SYN_EMAIL_ALPHA"),
      source("transaction_purpose", "purchase"),
      source("property_use", "primary"),
      source("property_state", "CA"),
      source("estimated_property_value", 500_000),
      source("requested_loan_amount", 300_000),
      source("income_summary", "SYN_INCOME_STABLE"),
      source("asset_summary", "SYN_ASSET_STABLE"),
      source("credit_consent_status", "confirmed"),
    ],
  });
}

describe("lead intake domain rules", () => {
  it("classifies a complete case without making a lending decision", () => {
    const result = evaluateLeadIntake(completeCase());
    expect(result.readiness_class).toBe("READY_FOR_HUMAN_QUOTE_REVIEW");
    expect(result.queue).toBe("QUOTE_REVIEW");
    expect(result.issue_codes).toEqual(["OPTIONAL_PHONE_MISSING"]);
    expect(result.prohibited_conclusions).toContain("RATE_OR_PAYMENT");
    expect(result.follow_up_draft).toBeNull();
  });

  it("reports missing and malformed values without inventing them", () => {
    const input = {
      ...completeCase(),
      contact_method: { email_token: "not-an-email-token" },
      property_state: "ZZ",
      transaction_purpose: undefined,
      sources: completeCase().sources.filter((source) => source.field !== "transaction_purpose"),
    };
    const parsed = LeadIntakeCaseInputSchema.parse(input);
    expect(getMissingRequiredFields(parsed)).toEqual(["transaction_purpose"]);
    const result = evaluateLeadIntake(parsed);
    expect(result.readiness_class).toBe("NEEDS_INFORMATION");
    expect(result.malformed_fields).toEqual(["contact_method", "property_state"]);
    expect(result.follow_up_draft).toContain("transaction_purpose");
  });

  it("treats Unicode whitespace as empty", () => {
    const parsed = LeadIntakeCaseInputSchema.parse({
      ...completeCase(),
      contact_method: { email_token: "\u2003" },
    });
    expect(getMissingRequiredFields(parsed)).toContain("contact_method");
  });

  it("preserves contradictions and routes them to human review", () => {
    const original = completeCase();
    const parsed = LeadIntakeCaseInputSchema.parse({
      ...original,
      sources: [
        ...original.sources,
        {
          field: "property_use",
          source_id: "SYN-SOURCE-NOTES",
          source_timestamp: original.evaluation_as_of,
          value: "investment",
        },
      ],
    });
    const result = evaluateLeadIntake(parsed);
    expect(result.readiness_class).toBe("CONTRADICTION_REVIEW");
    expect(result.queue).toBe("DATA_CONTRADICTION");
    expect(result.contradictions[0]?.left.value).toBe("primary");
    expect(result.contradictions[0]?.right.value).toBe("investment");
  });

  it("routes policy signals with provisional compliance where required", () => {
    const compliance = evaluateLeadIntake(
      LeadIntakeCaseInputSchema.parse({
        ...completeCase(),
        case_id: "LIQR-011",
        signals: ["PROTECTED_CHARACTERISTIC_REQUEST"],
      }),
    );
    expect(compliance.readiness_class).toBe("POLICY_ESCALATION");
    expect(compliance.queue).toBe("COMPLIANCE_REVIEW");
    expect(compliance.compliance_status).toBe("PROVISIONAL_COMPLIANCE");
    expect(compliance.denied_capabilities).toEqual(["PROTECTED_REASONING"]);

    const security = evaluateLeadIntake(
      LeadIntakeCaseInputSchema.parse({
        ...completeCase(),
        case_id: "LIQR-009",
        signals: ["PROMPT_INJECTION"],
      }),
    );
    expect(security.queue).toBe("SECURITY_REVIEW");
    expect(security.compliance_status).toBe("NOT_APPLICABLE");
  });

  it("uses an inclusive 90-day freshness boundary and rejects future sources", () => {
    expect(isSourceFresh("2026-05-31T12:00:00Z", "2026-08-29T12:00:00Z")).toBe(true);
    expect(isSourceFresh("2026-05-31T11:59:59.999Z", "2026-08-29T12:00:00Z")).toBe(false);
    expect(isSourceFresh("2026-08-29T12:00:00.001Z", "2026-08-29T12:00:00Z")).toBe(false);
  });

  it("rejects a missing source timestamp at the contract boundary", () => {
    const firstSource = completeCase().sources[0]!;
    const { source_timestamp: _timestamp, ...withoutTimestamp } = firstSource;
    expect(
      LeadIntakeCaseInputSchema.safeParse({
        ...completeCase(),
        sources: [withoutTimestamp, ...completeCase().sources.slice(1)],
      }).success,
    ).toBe(false);
  });
});

describe("bounded evaluation state machine", () => {
  it("accepts every declared transition and allows active states to halt", () => {
    for (const [from, to] of ALLOWED_STATE_TRANSITIONS) {
      expect(canTransitionEvaluationState(from, to)).toBe(true);
    }
    expect(canTransitionEvaluationState("ANALYZING", "HALTED_OPERATOR")).toBe(true);
  });

  it("fails closed on illegal and terminal transitions", () => {
    expect(canTransitionEvaluationState("CREATED", "ANALYZING")).toBe(false);
    expect(canTransitionEvaluationState("ACCEPTED", "PREFLIGHT")).toBe(false);
    expect(canTransitionEvaluationState("HALTED_RUNTIME", "CREATED")).toBe(false);
  });

  it("is idempotent by transition ID and fenced against stale writers", () => {
    const initial = { state: "CREATED" as const, fence: 0, transitions: [] };
    const request = {
      transition_id: "TRANSITION-PREFLIGHT",
      to: "PREFLIGHT" as const,
      expected_fence: 0,
      occurred_at: "2026-08-29T12:00:00Z",
    };
    const transitioned = applyEvaluationTransition(initial, request);
    expect(applyEvaluationTransition(transitioned, request)).toBe(transitioned);
    expect(() =>
      applyEvaluationTransition(transitioned, {
        transition_id: "TRANSITION-STALE",
        to: "VALIDATING",
        expected_fence: 0,
        occurred_at: "2026-08-29T12:00:01Z",
      }),
    ).toThrow(/stale/i);
    expect(() => applyEvaluationTransition(transitioned, { ...request, to: "VALIDATING" })).toThrow(
      /changed its target/i,
    );
  });
});
