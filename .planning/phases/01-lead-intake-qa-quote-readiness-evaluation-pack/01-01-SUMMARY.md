---
phase: 01-lead-intake-qa-quote-readiness-evaluation-pack
plan: 01
subsystem: evaluation
tags: [zod, vitest, synthetic-data, state-machine, evidence-isolation]

requires:
  - phase: 01-lead-intake-qa-quote-readiness-evaluation-pack
    provides: frozen evaluation specification and 20-case answer key
provides:
  - strict contracts for synthetic cases, expected outcomes, evidence outputs, budgets, and states
  - deterministic lead-intake validation and fenced state-transition rules
  - exactly 20 symbolic cases with separately rooted frozen expected outcomes
  - evaluator and verifier reader separation with payload-isolation tests
affects: [evaluation-policy, evidence-packets, campaign-runner, independent-verifier]

tech-stack:
  added: []
  patterns: [strict Zod contracts, pure offline evaluator, fenced state transitions, split corpus roots]

key-files:
  created:
    - packages/contracts/src/evaluation.ts
    - packages/core/src/evaluation/lead-intake.ts
    - packages/testkit/src/evaluations/lead-intake-v1/corpus.test.ts
    - packages/testkit/src/evaluations/lead-intake-v1/cases/LIQR-001.json
    - packages/testkit/src/evaluations/lead-intake-v1/expected/LIQR-001.json
  modified:
    - packages/contracts/src/index.ts
    - packages/core/src/evaluation/lead-intake.test.ts

key-decisions:
  - "The frozen case catalog controls Case 02: a valid synthetic email is quote-review ready and produces no follow-up draft."
  - "LIQR-011, LIQR-012, and LIQR-013 are mechanically testable only with PROVISIONAL_COMPLIANCE status."
  - "Evaluator readers receive case data only; verifier readers are the only readers with an expected-outcome method."

patterns-established:
  - "Closed contract: every case, outcome, output, state, and queue rejects unknown values."
  - "Expected isolation: cases and outcomes use separate roots; evaluator serialization validates and includes only the case."
  - "Fail-closed transition: transition IDs are idempotent and stale fences or illegal edges throw."

requirements-completed: [EVAL-01, EVAL-02, EVAL-03, EVAL-04, EVAL-05, EVAL-06, EVAL-07, EVAL-08]

duration: 14min
completed: 2026-08-29
status: complete
---

# Phase 1 Plan 1: Contracts, Corpus, and Deterministic Domain Rules Summary

**Strict synthetic evaluation contracts, a pure non-consequential intake classifier, a fenced state machine, and 20 isolated case/answer pairs now provide the deterministic foundation for later campaign and verifier plans.**

## Performance

- **Duration:** 14 min
- **Started:** 2026-08-30T00:11:53Z
- **Completed:** 2026-08-30T00:25:38Z
- **Tasks:** 4
- **Files modified:** 45

## Accomplishments

- Added strict Zod schemas for synthetic case inputs, source attribution, expected outcomes, evidence output, budgets, terminal reasons, and the bounded state vocabulary.
- Implemented pure required-field, symbolic-contact, state-code, 90-day freshness, attribution, contradiction, routing, provisional-compliance, and fenced-transition logic without a lending-decision surface.
- Materialized exactly `LIQR-001` through `LIQR-020` as symbolic inputs and separately rooted expected outcomes; LIQR-011/012/013 are explicitly `PROVISIONAL_COMPLIANCE`.
- Proved evaluator readers and serialized payloads contain no expected-only keys, sentinels, expected-file hashes, or expected-root mount.

## Task Commits

Each task was committed atomically:

1. **Task 1: Define closed schemas** - `42c89c8` (feat)
2. **Task 2: Implement pure domain validators** - `4a8cfe7` (feat)
3. **Task 3: Materialize the 20-case corpus** - `64baa7b` (test)
4. **Task 4: Prove expected-outcome isolation** - `e61ce56` (test)

## Files Created/Modified

- `packages/contracts/src/evaluation.ts` - Closed schemas and controlled vocabularies.
- `packages/contracts/src/index.ts` - Public evaluation-contract export.
- `packages/core/src/evaluation/lead-intake.ts` - Pure evaluator, reader split, serialization boundary, and state machine.
- `packages/core/src/evaluation/lead-intake.test.ts` - Fourteen contract/domain/state tests.
- `packages/testkit/src/evaluations/lead-intake-v1/cases/*.json` - Exactly 20 symbolic evaluator inputs.
- `packages/testkit/src/evaluations/lead-intake-v1/expected/*.json` - Exactly 20 frozen verifier-only outcomes.
- `packages/testkit/src/evaluations/lead-intake-v1/corpus.test.ts` - Six corpus, linter, exact-outcome, provisional-label, and isolation tests.

## Decisions Made

- The evaluator reports intake readiness only and always records that eligibility, creditworthiness, approval/denial, rates/payments, pricing, and lender/product selection are prohibited conclusions.
- Compliance routing does not imply qualified compliance advice. Only cases 011-013 carry `PROVISIONAL_COMPLIANCE`, and the schema has no qualified-compliance value.
- `01-EVALUATION-PACK.md` is the frozen case-level authority where its Case 02 no-draft result conflicts with the broader `01-SPEC.md` EVAL-07 sentence.
- Source freshness is inclusive at exactly 90 days and fails for older or future-dated source timestamps.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Prevented malformed email tokens from creating an optional-phone observation**

- **Found during:** Task 3 (20-case exact-outcome verification)
- **Issue:** The first implementation treated any email string as a valid contact when deciding whether phone was only optionally absent, which polluted LIQR-008's exact format-error set.
- **Fix:** `OPTIONAL_PHONE_MISSING` is now emitted only when the email token itself passes the symbolic contact format.
- **Files modified:** `packages/core/src/evaluation/lead-intake.ts`
- **Verification:** All 20 computed outputs exactly match their frozen expected fields.
- **Committed in:** `64baa7b`

### Plan Clarification

- `01-SPEC.md` says Case 02 should contain a local follow-up draft, while the frozen case catalog says the valid email satisfies contact and requires no draft. The implementation follows the frozen catalog and records the discrepancy here; no expected result was renegotiated after execution.

---

**Total deviations:** 1 auto-fixed bug and 1 documented frozen-spec conflict.
**Impact on plan:** No scope expansion, authority widening, external action, or expected-outcome mutation occurred.

## Verification

- `pnpm --filter @rakazo/contracts check` - exit 0.
- `pnpm test -- packages/core/src/evaluation/lead-intake.test.ts` - exit 0; 14 tests passed.
- `pnpm test -- packages/testkit/src/evaluations/lead-intake-v1/corpus.test.ts` - exit 0; 6 tests passed.
- `pnpm --filter @rakazo/core check` - exit 0.
- Focused Biome check over all 45 changed source/fixture files - exit 0.
- Corpus inventory - exactly 20 case JSON files and 20 expected JSON files.

## Issues Encountered

- The default Node.js was 22.14.0, below a lockfile dependency's `>=22.19.0` engine. Verification used an already-installed Node 22.23.2. `pnpm install --frozen-lockfile` completed without changing the lockfile.
- The local GSD helper failed before execution because its installed runtime could not load `../../../package.json`. Per the assignment, no shared GSD state files were changed.
- A broad `pnpm --filter @rakazo/testkit check` remains blocked by pre-existing missing `packages/db/src/generated/prisma/client.js` and unrelated implicit-any errors in `packages/adapters`. Plan 01's targeted corpus test and all owned-package checks pass; out-of-scope files were not changed.

## Known Stubs

None. Empty arrays in the evaluator are local accumulators or valid closed-schema outputs, not UI/data placeholders.

## Threat Flags

None. Plan 01 adds no network endpoint, authentication path, connector, database schema, production path, or external-effect surface.

## User Setup Required

None - no credential, external service, connector, or production configuration is required.

## Next Phase Readiness

- Plans 02-04 can consume the strict contracts, deterministic evaluator, case corpus, and verifier-only answer root.
- This is Plan 01 completion only. The phase still requires server-side tool policy, evidence packets, campaign metrics/verdicts, shutdown, and rollback work.
- Any synthetic-to-real transition remains hard-blocked pending independent human and qualified security/compliance review.

## Self-Check: PASSED

- All declared contract, domain, corpus, expected-outcome, test, and summary files exist.
- Exactly 20 case files and 20 expected files are present.
- All four task commits are reachable from the worktree branch.
- The implementation diff contains only Plan 01-owned files; no shared state, roadmap, lockfile, runtime, connector, database, UI, or canonical-checkout file changed.

---
*Phase: 01-lead-intake-qa-quote-readiness-evaluation-pack, Plan 01*
*Completed: 2026-08-29*
