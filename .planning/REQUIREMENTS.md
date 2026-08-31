# Requirements: Rakazo Evaluation Pack v1

**Defined:** 2026-08-28
**Core Value:** Produce reproducible, independently verifiable synthetic evidence without production authority.

## v1 Requirements

### Evaluation Pack

- [ ] **EVAL-01**: Validate exactly 20 closed-schema synthetic cases.
- [ ] **EVAL-02**: Keep expected outcomes isolated from evaluator inputs.
- [ ] **EVAL-03**: Enforce the bounded state machine and fail closed on illegal transitions.
- [ ] **EVAL-04**: Report completeness and source attribution without inventing facts.
- [ ] **EVAL-05**: Preserve contradictions and route them to human review.
- [ ] **EVAL-06**: Use only non-consequential readiness classifications.
- [ ] **EVAL-07**: Generate local draft-only follow-up with no external send.
- [ ] **EVAL-08**: Use exactly one queue from the closed queue vocabulary.
- [ ] **EVAL-09**: Enforce a task-scoped default-deny server policy before tool execution.
- [ ] **EVAL-10**: Enforce fixed turns, tools, time, token, retry, and cost limits.
- [ ] **EVAL-11**: Produce canonical hashed evidence packets and campaign manifests.
- [ ] **EVAL-12**: Bind approval receipts without widening phase authority.
- [ ] **EVAL-13**: Calculate exact release metrics without favorable rounding.
- [ ] **EVAL-14**: Emit deterministic ACCEPT, REJECT, or INVALID_PACK independently of the evaluator.
- [ ] **EVAL-15**: Halt and seal evidence within 60 seconds on every shutdown trigger.
- [ ] **EVAL-16**: Roll back only evaluation-owned state and preserve ordinary Rakazo behavior.
- [ ] **EVAL-17**: Keep coding and DevOps execution outside Rakazo's operational authority.
- [ ] **EVAL-18**: Fail preflight unless the environment is synthetic, dedicated/fake, and connector-free.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Real or redacted borrower data | Requires a separately approved phase and qualified review |
| Production credentials or connectors | Explicitly prohibited by the synthetic approval |
| CRM/LOS/lender writes, quoting, submissions, outbound communications | Consequential external actions are outside this pack |
| Live model/provider campaign | Would require credentials or an external call unless separately proven otherwise |
| Dell deployment or staff rollout | Deployment authority was not granted |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| EVAL-01 through EVAL-18 | Phase 1 | In Progress |

**Coverage:**
- v1 requirements: 18 total
- Mapped to phases: 18
- Unmapped: 0

---
*Requirements defined: 2026-08-28*
*Last updated: 2026-08-29 after approval amendment*
