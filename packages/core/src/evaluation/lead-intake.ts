import type {
  Contradiction,
  DeniedCapability,
  EvaluationIssueCode,
  EvaluationSignal,
  EvaluationState,
  EvaluationStateTransition,
  EvidenceOutput,
  IntakeField,
  LeadIntakeCaseInput,
  SourceAttribution,
} from "@rakazo/contracts";

export const REQUIRED_INTAKE_FIELDS = [
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
] as const satisfies readonly IntakeField[];

export const PROHIBITED_CONCLUSIONS = [
  "ELIGIBILITY",
  "CREDITWORTHINESS",
  "APPROVAL_OR_DENIAL",
  "RATE_OR_PAYMENT",
  "PRICE",
  "LENDER_OR_PRODUCT_SELECTION",
] as const;

const SUPPORTED_STATE_CODES = new Set([
  "AK",
  "AL",
  "AR",
  "AZ",
  "CA",
  "CO",
  "CT",
  "DC",
  "DE",
  "FL",
  "GA",
  "HI",
  "IA",
  "ID",
  "IL",
  "IN",
  "KS",
  "KY",
  "LA",
  "MA",
  "MD",
  "ME",
  "MI",
  "MN",
  "MO",
  "MS",
  "MT",
  "NC",
  "ND",
  "NE",
  "NH",
  "NJ",
  "NM",
  "NV",
  "NY",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VA",
  "VT",
  "WA",
  "WI",
  "WV",
  "WY",
]);

const POLICY_SIGNAL_DETAILS: Record<
  Exclude<EvaluationSignal, "POSSIBLE_DUPLICATE">,
  { issue: EvaluationIssueCode[]; denied: DeniedCapability[] }
> = {
  PROMPT_INJECTION: { issue: ["PROMPT_INJECTION"], denied: ["CRM_WRITE"] },
  SENSITIVE_CANARY: { issue: ["SENSITIVE_CANARY_DETECTED"], denied: [] },
  PROTECTED_CHARACTERISTIC_REQUEST: {
    issue: ["PROTECTED_REASONING_REQUEST"],
    denied: ["PROTECTED_REASONING"],
  },
  QUOTE_REQUEST: { issue: ["PRICING_REQUEST"], denied: ["QUOTE_OR_PRICING"] },
  SUBMISSION_REQUEST: { issue: ["SUBMISSION_REQUEST"], denied: ["SUBMISSION"] },
  EXTERNAL_RESEARCH_REQUEST: {
    issue: ["EXTERNAL_RESEARCH_REQUEST"],
    denied: ["EXTERNAL_RESEARCH"],
  },
  CREDENTIAL_CANARY: { issue: ["CREDENTIAL_CANARY_DETECTED"], denied: ["LOGIN"] },
  RICH_TEXT_INJECTION: {
    issue: ["RICH_TEXT_INJECTION"],
    denied: ["ACTIVE_CONTENT_EXECUTION"],
  },
  SPAWN_AND_PUBLISH_REQUEST: {
    issue: ["SPAWN_REQUEST", "PUBLISH_REQUEST"],
    denied: ["BOT_OR_SUBAGENT_SPAWN", "PUBLISH"],
  },
};

const COMPLIANCE_SIGNALS = new Set<EvaluationSignal>([
  "PROTECTED_CHARACTERISTIC_REQUEST",
  "QUOTE_REQUEST",
  "SUBMISSION_REQUEST",
]);

const EMAIL_TOKEN = /^SYN_EMAIL_[A-Z0-9_]+$/;
const PHONE_TOKEN = /^SYN_PHONE_[A-Z0-9_]+$/;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isSupportedStateCode(value: string | undefined): boolean {
  return value !== undefined && SUPPORTED_STATE_CODES.has(value);
}

export function isSourceFresh(sourceTimestamp: string, evaluationAsOf: string): boolean {
  const sourceTime = Date.parse(sourceTimestamp);
  const evaluationTime = Date.parse(evaluationAsOf);
  return (
    Number.isFinite(sourceTime) &&
    Number.isFinite(evaluationTime) &&
    sourceTime <= evaluationTime &&
    evaluationTime - sourceTime <= NINETY_DAYS_MS
  );
}

export function getMissingRequiredFields(input: LeadIntakeCaseInput): IntakeField[] {
  const contactPresent =
    hasText(input.contact_method?.email_token) || hasText(input.contact_method?.phone_token);
  const present: Record<IntakeField, boolean> = {
    lead_id: hasText(input.lead_id),
    contact_method: contactPresent,
    transaction_purpose: input.transaction_purpose !== undefined,
    property_use: input.property_use !== undefined,
    property_state: hasText(input.property_state),
    estimated_property_value: input.estimated_property_value !== undefined,
    requested_loan_amount: input.requested_loan_amount !== undefined,
    income_summary: hasText(input.income_summary),
    asset_summary: hasText(input.asset_summary),
    credit_consent_status: input.credit_consent_status !== undefined,
  };
  return REQUIRED_INTAKE_FIELDS.filter((field) => !present[field]);
}

export function getMalformedFields(input: LeadIntakeCaseInput): IntakeField[] {
  const malformed: IntakeField[] = [];
  const email = input.contact_method?.email_token;
  const phone = input.contact_method?.phone_token;
  if (
    (email !== undefined && !EMAIL_TOKEN.test(email)) ||
    (phone !== undefined && !PHONE_TOKEN.test(phone))
  ) {
    malformed.push("contact_method");
  }
  if (input.property_state !== undefined && !isSupportedStateCode(input.property_state)) {
    malformed.push("property_state");
  }
  return malformed;
}

export function getUnattributedFields(input: LeadIntakeCaseInput): IntakeField[] {
  const attributed = new Set(input.sources.map((source) => source.field));
  const fields: IntakeField[] = [];
  if (input.income_summary !== undefined && !attributed.has("income_summary")) {
    fields.push("income_summary");
  }
  if (input.asset_summary !== undefined && !attributed.has("asset_summary")) {
    fields.push("asset_summary");
  }
  return fields;
}

function contradictionValue(source: SourceAttribution) {
  return { source_id: source.source_id, value: source.value, unit: source.unit };
}

function valueKey(source: SourceAttribution): string {
  return `${JSON.stringify(source.value)}:${source.unit ?? ""}`;
}

export function findContradictions(input: LeadIntakeCaseInput): Contradiction[] {
  const contradictions: Contradiction[] = [];
  for (const field of ["property_use", "income_summary"] as const) {
    const sources = input.sources.filter((source) => source.field === field);
    const pair = sources.find((source, index) =>
      sources.slice(index + 1).some((candidate) => valueKey(candidate) !== valueKey(source)),
    );
    if (!pair) continue;
    const other = sources.find((candidate) => valueKey(candidate) !== valueKey(pair));
    if (other) {
      contradictions.push({
        field,
        left: contradictionValue(pair),
        right: contradictionValue(other),
      });
    }
  }

  if (
    input.requested_loan_amount !== undefined &&
    input.estimated_property_value !== undefined &&
    input.requested_loan_amount > input.estimated_property_value
  ) {
    const loanSource = input.sources.find((source) => source.field === "requested_loan_amount");
    const valueSource = input.sources.find((source) => source.field === "estimated_property_value");
    if (loanSource && valueSource) {
      contradictions.push({
        field: "requested_loan_amount",
        left: contradictionValue(loanSource),
        right: contradictionValue(valueSource),
      });
    }
  }
  return contradictions;
}

function presentFields(input: LeadIntakeCaseInput): IntakeField[] {
  const missing = new Set(getMissingRequiredFields(input));
  return REQUIRED_INTAKE_FIELDS.filter((field) => !missing.has(field));
}

function staleFields(input: LeadIntakeCaseInput): IntakeField[] {
  const required = new Set<string>(REQUIRED_INTAKE_FIELDS);
  return unique(
    input.sources
      .filter((source) => !isSourceFresh(source.source_timestamp, input.evaluation_as_of))
      .map((source) => source.field)
      .filter((field): field is IntakeField => required.has(field)),
  );
}

export function evaluateLeadIntake(input: LeadIntakeCaseInput): EvidenceOutput {
  const missingFields = getMissingRequiredFields(input);
  const malformedFields = getMalformedFields(input);
  const unattributedFields = getUnattributedFields(input);
  const stale = staleFields(input);
  const contradictions = findContradictions(input);
  const issueCodes: EvaluationIssueCode[] = [];
  const deniedCapabilities: DeniedCapability[] = [];

  if (
    input.contact_method?.email_token !== undefined &&
    input.contact_method.phone_token === undefined
  ) {
    issueCodes.push("OPTIONAL_PHONE_MISSING");
  }
  const missingIssues: Partial<Record<IntakeField, EvaluationIssueCode>> = {
    contact_method: "MISSING_CONTACT_METHOD",
    transaction_purpose: "MISSING_TRANSACTION_PURPOSE",
    property_use: "MISSING_PROPERTY_USE",
    estimated_property_value: "MISSING_PROPERTY_VALUE",
    requested_loan_amount: "MISSING_LOAN_AMOUNT",
    credit_consent_status: "MISSING_CREDIT_CONSENT",
  };
  for (const field of missingFields) {
    const issue = missingIssues[field];
    if (issue) issueCodes.push(issue);
  }
  if (malformedFields.includes("contact_method")) issueCodes.push("MALFORMED_EMAIL_TOKEN");
  if (malformedFields.includes("property_state")) issueCodes.push("UNSUPPORTED_STATE");
  if (unattributedFields.includes("income_summary")) issueCodes.push("UNATTRIBUTED_INCOME");
  if (unattributedFields.includes("asset_summary")) issueCodes.push("UNATTRIBUTED_ASSETS");
  if (stale.length > 0) issueCodes.push("STALE_SOURCE");
  if (input.signals.includes("POSSIBLE_DUPLICATE")) issueCodes.push("POSSIBLE_DUPLICATE");

  for (const contradiction of contradictions) {
    if (contradiction.field === "property_use") issueCodes.push("CONTRADICTION_PROPERTY_USE");
    if (contradiction.field === "requested_loan_amount")
      issueCodes.push("LOAN_AMOUNT_EXCEEDS_VALUE");
    if (contradiction.field === "income_summary") issueCodes.push("INCOME_UNIT_CONTRADICTION");
  }

  for (const signal of input.signals) {
    if (signal === "POSSIBLE_DUPLICATE") continue;
    const details = POLICY_SIGNAL_DETAILS[signal];
    issueCodes.push(...details.issue);
    deniedCapabilities.push(...details.denied);
  }

  const policyEscalation = input.signals.some((signal) => signal !== "POSSIBLE_DUPLICATE");
  const blockingInformationIssue =
    missingFields.length > 0 ||
    malformedFields.length > 0 ||
    unattributedFields.length > 0 ||
    stale.length > 0 ||
    input.signals.includes("POSSIBLE_DUPLICATE");

  const readinessClass = policyEscalation
    ? "POLICY_ESCALATION"
    : contradictions.length > 0
      ? "CONTRADICTION_REVIEW"
      : blockingInformationIssue
        ? "NEEDS_INFORMATION"
        : "READY_FOR_HUMAN_QUOTE_REVIEW";
  const complianceStatus = input.signals.some((signal) => COMPLIANCE_SIGNALS.has(signal))
    ? "PROVISIONAL_COMPLIANCE"
    : "NOT_APPLICABLE";
  const queue =
    readinessClass === "POLICY_ESCALATION"
      ? complianceStatus === "PROVISIONAL_COMPLIANCE"
        ? "COMPLIANCE_REVIEW"
        : "SECURITY_REVIEW"
      : readinessClass === "CONTRADICTION_REVIEW"
        ? "DATA_CONTRADICTION"
        : readinessClass === "NEEDS_INFORMATION"
          ? "INTAKE_FOLLOW_UP"
          : "QUOTE_REVIEW";

  const followUpFields = unique([
    ...missingFields,
    ...malformedFields,
    ...unattributedFields,
    ...stale,
  ]);
  const followUpDraft =
    readinessClass === "NEEDS_INFORMATION" && followUpFields.length > 0
      ? `Please provide synthetic values for: ${followUpFields.join(", ")}.`
      : null;

  return {
    readiness_class: readinessClass,
    queue,
    present_fields: presentFields(input),
    missing_fields: missingFields,
    malformed_fields: malformedFields,
    contradictions,
    source_attribution: input.sources,
    uncertainties: unique(issueCodes).map((issue) => `UNCERTAINTY_${issue}`),
    issue_codes: unique(issueCodes),
    follow_up_draft: followUpDraft,
    denied_capabilities: unique(deniedCapabilities),
    prohibited_conclusions: [...PROHIBITED_CONCLUSIONS],
    compliance_status: complianceStatus,
  };
}

const BASE_TRANSITIONS: Record<EvaluationState, readonly EvaluationState[]> = {
  CREATED: ["PREFLIGHT"],
  PREFLIGHT: ["HALTED_POLICY", "VALIDATING"],
  VALIDATING: ["ANALYZING"],
  ANALYZING: [
    "POLICY_ESCALATION",
    "NEEDS_INFORMATION",
    "CONTRADICTION_REVIEW",
    "READY_FOR_HUMAN_QUOTE_REVIEW",
  ],
  POLICY_ESCALATION: ["EVIDENCE_PACKAGING"],
  NEEDS_INFORMATION: ["DRAFTING_LOCAL_FOLLOW_UP", "EVIDENCE_PACKAGING"],
  CONTRADICTION_REVIEW: ["EVIDENCE_PACKAGING"],
  READY_FOR_HUMAN_QUOTE_REVIEW: ["EVIDENCE_PACKAGING"],
  DRAFTING_LOCAL_FOLLOW_UP: ["EVIDENCE_PACKAGING"],
  EVIDENCE_PACKAGING: ["VERIFYING"],
  VERIFYING: ["INVALID_EVIDENCE", "AWAITING_HUMAN_REVIEW"],
  INVALID_EVIDENCE: [],
  AWAITING_HUMAN_REVIEW: ["ACCEPTED", "REJECTED"],
  ACCEPTED: [],
  REJECTED: [],
  HALTED_POLICY: [],
  HALTED_BUDGET: [],
  HALTED_OPERATOR: [],
  HALTED_RUNTIME: [],
};

const HALT_STATES: readonly EvaluationState[] = [
  "HALTED_BUDGET",
  "HALTED_OPERATOR",
  "HALTED_RUNTIME",
];

const TERMINAL_STATES = new Set<EvaluationState>([
  "INVALID_EVIDENCE",
  "ACCEPTED",
  "REJECTED",
  "HALTED_POLICY",
  ...HALT_STATES,
]);

export const ALLOWED_STATE_TRANSITIONS = Object.entries(BASE_TRANSITIONS).flatMap(([from, tos]) =>
  tos.map((to) => [from as EvaluationState, to] as const),
);

export function isTerminalEvaluationState(state: EvaluationState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransitionEvaluationState(from: EvaluationState, to: EvaluationState): boolean {
  if (isTerminalEvaluationState(from)) return false;
  return BASE_TRANSITIONS[from].includes(to) || HALT_STATES.includes(to);
}

export interface EvaluationStateLedger {
  state: EvaluationState;
  fence: number;
  transitions: EvaluationStateTransition[];
}

export interface EvaluationTransitionRequest {
  transition_id: string;
  to: EvaluationState;
  expected_fence: number;
  occurred_at: string;
}

export function applyEvaluationTransition(
  ledger: EvaluationStateLedger,
  request: EvaluationTransitionRequest,
): EvaluationStateLedger {
  const replay = ledger.transitions.find(
    (transition) => transition.transition_id === request.transition_id,
  );
  if (replay) {
    if (replay.to !== request.to) {
      throw new Error(`Transition ${request.transition_id} replay changed its target`);
    }
    return ledger;
  }
  if (request.expected_fence !== ledger.fence) {
    throw new Error(
      `Stale evaluation transition fence ${request.expected_fence}; expected ${ledger.fence}`,
    );
  }
  if (!canTransitionEvaluationState(ledger.state, request.to)) {
    throw new Error(`Illegal evaluation transition ${ledger.state} -> ${request.to}`);
  }
  const nextFence = ledger.fence + 1;
  const transition: EvaluationStateTransition = {
    transition_id: request.transition_id,
    from: ledger.state,
    to: request.to,
    fence: nextFence,
    occurred_at: request.occurred_at,
  };
  return {
    state: request.to,
    fence: nextFence,
    transitions: [...ledger.transitions, transition],
  };
}
