# Roadmap: Rakazo Evaluation Pack v1

## Overview

Build the frozen Lead Intake QA and Quote Readiness pack in three dependency waves: contracts/corpus, policy and budgets, evidence/verifier, then offline UAT and rollback readiness. The phase ends at synthetic evidence and cannot promote itself to real systems.

## Phases

- [ ] **Phase 1: Lead Intake QA and Quote Readiness Evaluation Pack** - Implement and verify the 20-case synthetic pack.

## Phase Details

### Phase 1: Lead Intake QA and Quote Readiness Evaluation Pack
**Goal**: Run 20 synthetic/adversarial cases three times through a bounded offline workflow and issue a deterministic verdict with complete evidence.
**Depends on**: Nothing
**Requirements**: EVAL-01, EVAL-02, EVAL-03, EVAL-04, EVAL-05, EVAL-06, EVAL-07, EVAL-08, EVAL-09, EVAL-10, EVAL-11, EVAL-12, EVAL-13, EVAL-14, EVAL-15, EVAL-16, EVAL-17, EVAL-18
**Success Criteria**:
  1. Exactly 20 synthetic fixtures and isolated expected outcomes validate.
  2. Policy, budget, shutdown, and rollback negative tests fail closed.
  3. The offline 60-run campaign produces complete hashed evidence and an independent deterministic verdict.
  4. Compliance-routed cases remain provisional and no production authority is enabled.
**Plans**: 4 plans

Plans:
- [x] 01-01: Contracts, corpus, and deterministic domain rules
- [ ] 01-02: Task-scoped policy, budgets, approvals, and shutdown
- [ ] 01-03: Hermetic campaign runner, evidence, and verifier
- [ ] 01-04: Offline UAT, shutdown/rollback rehearsal, and release-readiness report

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Lead Intake QA and Quote Readiness Evaluation Pack | 1/4 | In progress | - |
