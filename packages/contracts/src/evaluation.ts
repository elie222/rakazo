import * as z from "zod";

export const EVALUATION_PACK_ID = "lead-intake-quote-readiness-v1" as const;

export const EvaluationCaseIdSchema = z.string().regex(/^LIQR-(00[1-9]|01[0-9]|020)$/);
export type EvaluationCaseId = z.infer<typeof EvaluationCaseIdSchema>;

export const ReadinessClassSchema = z.enum([
  "READY_FOR_HUMAN_QUOTE_REVIEW",
  "NEEDS_INFORMATION",
  "CONTRADICTION_REVIEW",
  "POLICY_ESCALATION",
]);
export type ReadinessClass = z.infer<typeof ReadinessClassSchema>;

export const EvaluationQueueSchema = z.enum([
  "QUOTE_REVIEW",
  "INTAKE_FOLLOW_UP",
  "DATA_CONTRADICTION",
  "SECURITY_REVIEW",
  "COMPLIANCE_REVIEW",
]);
export type EvaluationQueue = z.infer<typeof EvaluationQueueSchema>;

export const ComplianceStatusSchema = z.enum(["NOT_APPLICABLE", "PROVISIONAL_COMPLIANCE"]);
export type ComplianceStatus = z.infer<typeof ComplianceStatusSchema>;

export const IntakeFieldSchema = z.enum([
  "lead_id",
  "contact_method",
  "transaction_purpose",
  "property_use",
  "property_state",
  "estimated_property_value",
  "requested_loan_amount",
  "income_summary",
  "asset_summary",
  "credit_consent_status",
]);
export type IntakeField = z.infer<typeof IntakeFieldSchema>;

export const SourceFieldSchema = z.enum([...IntakeFieldSchema.options, "notes", "external_source"]);
export type SourceField = z.infer<typeof SourceFieldSchema>;

export const EvaluationSignalSchema = z.enum([
  "POSSIBLE_DUPLICATE",
  "PROMPT_INJECTION",
  "SENSITIVE_CANARY",
  "PROTECTED_CHARACTERISTIC_REQUEST",
  "QUOTE_REQUEST",
  "SUBMISSION_REQUEST",
  "EXTERNAL_RESEARCH_REQUEST",
  "CREDENTIAL_CANARY",
  "RICH_TEXT_INJECTION",
  "SPAWN_AND_PUBLISH_REQUEST",
]);
export type EvaluationSignal = z.infer<typeof EvaluationSignalSchema>;

export const EvaluationIssueCodeSchema = z.enum([
  "OPTIONAL_PHONE_MISSING",
  "MISSING_CONTACT_METHOD",
  "MISSING_TRANSACTION_PURPOSE",
  "MISSING_PROPERTY_USE",
  "MISSING_PROPERTY_VALUE",
  "MISSING_LOAN_AMOUNT",
  "MISSING_CREDIT_CONSENT",
  "CONTRADICTION_PROPERTY_USE",
  "LOAN_AMOUNT_EXCEEDS_VALUE",
  "POSSIBLE_DUPLICATE",
  "MALFORMED_EMAIL_TOKEN",
  "UNSUPPORTED_STATE",
  "PROMPT_INJECTION",
  "SENSITIVE_CANARY_DETECTED",
  "PROTECTED_REASONING_REQUEST",
  "PRICING_REQUEST",
  "SUBMISSION_REQUEST",
  "EXTERNAL_RESEARCH_REQUEST",
  "CREDENTIAL_CANARY_DETECTED",
  "RICH_TEXT_INJECTION",
  "INCOME_UNIT_CONTRADICTION",
  "STALE_SOURCE",
  "UNATTRIBUTED_INCOME",
  "UNATTRIBUTED_ASSETS",
  "SPAWN_REQUEST",
  "PUBLISH_REQUEST",
]);
export type EvaluationIssueCode = z.infer<typeof EvaluationIssueCodeSchema>;

export const DeniedCapabilitySchema = z.enum([
  "CRM_WRITE",
  "EXTERNAL_RESEARCH",
  "LOGIN",
  "PROTECTED_REASONING",
  "QUOTE_OR_PRICING",
  "SUBMISSION",
  "BOT_OR_SUBAGENT_SPAWN",
  "PUBLISH",
  "ACTIVE_CONTENT_EXECUTION",
]);
export type DeniedCapability = z.infer<typeof DeniedCapabilitySchema>;

const SymbolicIdSchema = z.string().regex(/^SYN-[A-Z0-9][A-Z0-9_-]*$/);
const SymbolicSummarySchema = z.string().regex(/^SYN_[A-Z0-9][A-Z0-9_:-]*$/);

export const SourceAttributionSchema = z.strictObject({
  field: SourceFieldSchema,
  source_id: SymbolicIdSchema,
  source_timestamp: z.string().datetime({ offset: true }),
  value: z.union([z.string(), z.number().finite(), z.boolean()]),
  unit: z.enum(["USD", "MONTHLY", "ANNUAL", "TOKEN"]).optional(),
});
export type SourceAttribution = z.infer<typeof SourceAttributionSchema>;

export const ContactMethodSchema = z.strictObject({
  email_token: z.string().optional(),
  phone_token: z.string().optional(),
});

export const LeadIntakeCaseInputSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  pack_id: z.literal(EVALUATION_PACK_ID),
  case_id: EvaluationCaseIdSchema,
  synthetic: z.literal(true),
  evaluation_as_of: z.string().datetime({ offset: true }),
  lead_id: SymbolicIdSchema,
  contact_method: ContactMethodSchema.optional(),
  transaction_purpose: z.enum(["purchase", "refinance"]).optional(),
  property_use: z.enum(["primary", "secondary", "investment"]).optional(),
  property_state: z.string().optional(),
  estimated_property_value: z.number().int().positive().optional(),
  requested_loan_amount: z.number().int().positive().optional(),
  income_summary: SymbolicSummarySchema.optional(),
  asset_summary: SymbolicSummarySchema.optional(),
  credit_consent_status: z.enum(["confirmed", "declined", "unknown"]).optional(),
  sources: z.array(SourceAttributionSchema),
  signals: z.array(EvaluationSignalSchema).default([]),
  duplicate_candidate_id: SymbolicIdSchema.optional(),
  notes: z.string().optional(),
  external_source: z
    .strictObject({
      locator_token: SymbolicSummarySchema,
      instruction: z.string(),
    })
    .optional(),
});
export type LeadIntakeCaseInput = z.infer<typeof LeadIntakeCaseInputSchema>;

export const ContradictionValueSchema = z.strictObject({
  source_id: SymbolicIdSchema,
  value: z.union([z.string(), z.number().finite(), z.boolean()]),
  unit: z.enum(["USD", "MONTHLY", "ANNUAL", "TOKEN"]).optional(),
});

export const ContradictionSchema = z.strictObject({
  field: IntakeFieldSchema,
  left: ContradictionValueSchema,
  right: ContradictionValueSchema,
});
export type Contradiction = z.infer<typeof ContradictionSchema>;

export const ExpectedOutcomeSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  pack_id: z.literal(EVALUATION_PACK_ID),
  case_id: EvaluationCaseIdSchema,
  readiness_class: ReadinessClassSchema,
  queue: EvaluationQueueSchema,
  issue_codes: z.array(EvaluationIssueCodeSchema),
  missing_fields: z.array(IntakeFieldSchema),
  malformed_fields: z.array(IntakeFieldSchema),
  contradiction_fields: z.array(IntakeFieldSchema),
  follow_up_required: z.boolean(),
  follow_up_fields: z.array(IntakeFieldSchema),
  denied_capabilities: z.array(DeniedCapabilitySchema),
  critical: z.boolean(),
  compliance_status: ComplianceStatusSchema,
  isolation_sentinel: z.string().regex(/^EXPECTED_ONLY_LIQR_\d{3}$/),
});
export type ExpectedOutcome = z.infer<typeof ExpectedOutcomeSchema>;

export const ProhibitedConclusionSchema = z.enum([
  "ELIGIBILITY",
  "CREDITWORTHINESS",
  "APPROVAL_OR_DENIAL",
  "RATE_OR_PAYMENT",
  "PRICE",
  "LENDER_OR_PRODUCT_SELECTION",
]);

export const EvidenceOutputSchema = z.strictObject({
  readiness_class: ReadinessClassSchema,
  queue: EvaluationQueueSchema,
  present_fields: z.array(IntakeFieldSchema),
  missing_fields: z.array(IntakeFieldSchema),
  malformed_fields: z.array(IntakeFieldSchema),
  contradictions: z.array(ContradictionSchema),
  source_attribution: z.array(SourceAttributionSchema),
  uncertainties: z.array(z.string()),
  issue_codes: z.array(EvaluationIssueCodeSchema),
  follow_up_draft: z.string().nullable(),
  denied_capabilities: z.array(DeniedCapabilitySchema),
  prohibited_conclusions: z.array(ProhibitedConclusionSchema),
  compliance_status: ComplianceStatusSchema,
});
export type EvidenceOutput = z.infer<typeof EvidenceOutputSchema>;

export const EvaluationStateSchema = z.enum([
  "CREATED",
  "PREFLIGHT",
  "VALIDATING",
  "ANALYZING",
  "POLICY_ESCALATION",
  "NEEDS_INFORMATION",
  "CONTRADICTION_REVIEW",
  "READY_FOR_HUMAN_QUOTE_REVIEW",
  "DRAFTING_LOCAL_FOLLOW_UP",
  "EVIDENCE_PACKAGING",
  "VERIFYING",
  "INVALID_EVIDENCE",
  "AWAITING_HUMAN_REVIEW",
  "ACCEPTED",
  "REJECTED",
  "HALTED_POLICY",
  "HALTED_BUDGET",
  "HALTED_OPERATOR",
  "HALTED_RUNTIME",
]);
export type EvaluationState = z.infer<typeof EvaluationStateSchema>;

export const EvaluationStateTransitionSchema = z.strictObject({
  transition_id: z.string().regex(/^TRANSITION-[A-Z0-9_-]+$/),
  from: EvaluationStateSchema,
  to: EvaluationStateSchema,
  fence: z.number().int().nonnegative(),
  occurred_at: z.string().datetime({ offset: true }),
});
export type EvaluationStateTransition = z.infer<typeof EvaluationStateTransitionSchema>;

export const EvaluationBudgetSchema = z.strictObject({
  max_turns: z.number().int().positive(),
  max_tool_calls: z.number().int().positive(),
  max_wall_time_ms: z.number().int().positive(),
  max_retries: z.number().int().nonnegative(),
  max_input_tokens: z.number().int().positive(),
  max_output_tokens: z.number().int().positive(),
  max_cost_microdollars: z.number().int().nonnegative(),
  max_child_agents: z.literal(0),
});
export type EvaluationBudget = z.infer<typeof EvaluationBudgetSchema>;

export const EvaluationTerminalReasonSchema = z.enum([
  "complete",
  "policy_violation",
  "budget_exceeded",
  "operator_kill",
  "runtime_unavailable",
  "invalid_evidence",
]);
export type EvaluationTerminalReason = z.infer<typeof EvaluationTerminalReasonSchema>;
