import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  EvaluationCaseIdSchema,
  type ExpectedOutcome,
  ExpectedOutcomeSchema,
  type LeadIntakeCaseInput,
  LeadIntakeCaseInputSchema,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  evaluateLeadIntake,
  loadEvaluatorCase,
  loadVerifierCase,
  serializeEvaluatorInput,
} from "../../../../core/src/evaluation/lead-intake.js";
import { planCampaign } from "./run.js";

const root = import.meta.dirname;
const casesRoot = path.join(root, "cases");
const expectedRoot = path.join(root, "expected");
const expectedNames = Array.from(
  { length: 20 },
  (_, index) => `LIQR-${String(index + 1).padStart(3, "0")}.json`,
);

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function loadCases(): LeadIntakeCaseInput[] {
  return readdirSync(casesRoot)
    .sort()
    .map((name) => LeadIntakeCaseInputSchema.parse(readJson(path.join(casesRoot, name))));
}

function loadExpected(): ExpectedOutcome[] {
  return readdirSync(expectedRoot)
    .sort()
    .map((name) => ExpectedOutcomeSchema.parse(readJson(path.join(expectedRoot, name))));
}

function createEvaluatorLoader() {
  return {
    mountedRoots: [casesRoot] as const,
    readCase(caseId: string): unknown {
      const canonicalId = EvaluationCaseIdSchema.parse(caseId);
      return readJson(path.join(casesRoot, `${canonicalId}.json`));
    },
  };
}

function createVerifierLoader() {
  return {
    mountedRoots: [casesRoot, expectedRoot] as const,
    readCase(caseId: string): unknown {
      const canonicalId = EvaluationCaseIdSchema.parse(caseId);
      return readJson(path.join(casesRoot, `${canonicalId}.json`));
    },
    readExpected(caseId: string): unknown {
      const canonicalId = EvaluationCaseIdSchema.parse(caseId);
      return readJson(path.join(expectedRoot, `${canonicalId}.json`));
    },
  };
}

function validateCanonicalIds(cases: readonly LeadIntakeCaseInput[]): void {
  const ids = cases.map((item) => item.case_id);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate evaluation case ID");
  const canonical = expectedNames.map((name) => name.replace(".json", ""));
  if (JSON.stringify(ids) !== JSON.stringify(canonical)) {
    throw new Error("Evaluation case IDs are not the canonical LIQR-001 through LIQR-020 set");
  }
}

const REALISTIC_OR_SECRET_PATTERNS: readonly [string, RegExp][] = [
  ["email address", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ["SSN", /\b\d{3}-\d{2}-\d{4}\b/],
  ["long account-like number", /\b\d{9,19}\b/],
  ["private key", /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i],
  ["credential assignment", /(?:api[_-]?key|password|authorization)\s*[:=]/i],
  ["raw synthetic canary", /SYNTHETIC_(?:SENSITIVE|CREDENTIAL)_CANARY/],
  ["external URL", /https?:\/\//i],
  ["host path", /(?:\/Users\/|[A-Z]:\\)/],
];

describe("lead intake evaluation corpus v1", () => {
  it("rejects unbounded or invalid campaign iteration counts", () => {
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 4]) {
      expect(() => planCampaign(invalid)).toThrow(/iterations must be an integer between 1 and 3/);
    }
  });

  it("contains exactly the canonical 20 cases and 20 isolated expected outcomes", () => {
    expect(readdirSync(casesRoot).sort()).toEqual(expectedNames);
    expect(readdirSync(expectedRoot).sort()).toEqual(expectedNames);
    const cases = loadCases();
    validateCanonicalIds(cases);
    expect(cases).toHaveLength(20);
    expect(loadExpected()).toHaveLength(20);
  });

  it("rejects duplicate, missing, and noncanonical IDs", () => {
    const cases = loadCases();
    expect(() => validateCanonicalIds([...cases, cases[0]!])).toThrow(/duplicate/i);
    expect(() => validateCanonicalIds(cases.slice(1))).toThrow(/canonical/i);
    expect(EvaluationCaseIdSchema.safeParse("LIQR-000").success).toBe(false);
  });

  it("contains only symbolic data and no raw credential or PII-shaped values", () => {
    for (const input of loadCases()) {
      const serialized = JSON.stringify(input);
      for (const [label, pattern] of REALISTIC_OR_SECRET_PATTERNS) {
        expect(pattern.test(serialized), `${input.case_id} contains ${label}`).toBe(false);
      }
    }
  });

  it("matches every frozen expected outcome exactly", () => {
    const expectedById = new Map(loadExpected().map((item) => [item.case_id, item]));
    for (const input of loadCases()) {
      const expected = expectedById.get(input.case_id)!;
      const actual = evaluateLeadIntake(input);
      expect(
        {
          readiness_class: actual.readiness_class,
          queue: actual.queue,
          issue_codes: actual.issue_codes,
          missing_fields: actual.missing_fields,
          malformed_fields: actual.malformed_fields,
          contradiction_fields: actual.contradictions.map((item) => item.field),
          follow_up_required: actual.follow_up_draft !== null,
          follow_up_fields: expected.follow_up_fields.filter((field) =>
            actual.follow_up_draft?.includes(field),
          ),
          denied_capabilities: actual.denied_capabilities,
          compliance_status: actual.compliance_status,
        },
        input.case_id,
      ).toEqual({
        readiness_class: expected.readiness_class,
        queue: expected.queue,
        issue_codes: expected.issue_codes,
        missing_fields: expected.missing_fields,
        malformed_fields: expected.malformed_fields,
        contradiction_fields: expected.contradiction_fields,
        follow_up_required: expected.follow_up_required,
        follow_up_fields: expected.follow_up_fields,
        denied_capabilities: expected.denied_capabilities,
        compliance_status: expected.compliance_status,
      });
    }
  });

  it("freezes the exact critical set and provisional compliance labels", () => {
    const expected = loadExpected();
    expect(expected.filter((item) => item.critical).map((item) => item.case_id)).toEqual([
      "LIQR-005",
      "LIQR-006",
      "LIQR-009",
      "LIQR-010",
      "LIQR-011",
      "LIQR-012",
      "LIQR-013",
      "LIQR-014",
      "LIQR-015",
      "LIQR-016",
      "LIQR-017",
      "LIQR-019",
      "LIQR-020",
    ]);
    expect(
      expected
        .filter((item) => item.compliance_status === "PROVISIONAL_COMPLIANCE")
        .map((item) => item.case_id),
    ).toEqual(["LIQR-011", "LIQR-012", "LIQR-013"]);
  });

  it("keeps expected outcomes outside evaluator mounts and serialized payloads", () => {
    const evaluator = createEvaluatorLoader();
    const verifier = createVerifierLoader();
    expect(evaluator.mountedRoots).toEqual([casesRoot]);
    expect(evaluator.mountedRoots).not.toContain(expectedRoot);
    expect(verifier.mountedRoots).toEqual([casesRoot, expectedRoot]);
    expect("readExpected" in evaluator).toBe(false);
    expect(() => loadEvaluatorCase(evaluator, "../expected/LIQR-001")).toThrow();

    for (const name of expectedNames) {
      const caseId = name.replace(".json", "");
      const expectedBytes = readFileSync(path.join(expectedRoot, name));
      const expectedHash = createHash("sha256").update(expectedBytes).digest("hex");
      const expected = loadVerifierCase(verifier, caseId).expected;
      const fullEvaluatorPayload = [
        "Evaluate this closed synthetic intake case.",
        serializeEvaluatorInput(loadEvaluatorCase(evaluator, caseId)),
      ].join("\n");

      expect(fullEvaluatorPayload).not.toContain(expected.isolation_sentinel);
      expect(fullEvaluatorPayload).not.toContain(expectedHash);
      for (const expectedOnlyKey of [
        "readiness_class",
        "queue",
        "issue_codes",
        "isolation_sentinel",
        "critical",
        "compliance_status",
      ]) {
        expect(fullEvaluatorPayload).not.toContain(`"${expectedOnlyKey}"`);
      }
    }
  });
});
