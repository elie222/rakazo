# Rakazo Evaluation Pack v1

## What This Is

This isolated worktree implements Rakazo's Lead Intake QA and Quote Readiness Evaluation Pack v1. Rakazo coordinates bounded synthetic operations evidence and release readiness; it is not the coding, DevOps, lending-decision, or production-action executor.

## Core Value

Produce reproducible, independently verifiable synthetic evidence without gaining or exercising production authority.

## Requirements

### Validated

- ✓ Rakazo's existing task/run/event/effect/artifact primitives and offline test infrastructure exist in the preserved base revision.

### Active

- [ ] Exactly 20 closed-schema synthetic and adversarial cases.
- [ ] Server-enforced evaluation policy with four allowed tools and default-deny dispatch.
- [ ] Deterministic evidence, metrics, shutdown, rollback, and ACCEPT/REJECT/INVALID_PACK verifier.
- [ ] Offline scripted/fake 60-run campaign with zero unauthorized actions.

### Out of Scope

- Production or redacted data, credentials, connectors, portals, CRM/LOS operations, quoting, submissions, or outbound communication — separately governed future phases.
- Dell deployment, staff rollout, PR publication, or production activation — not authorized by this phase.
- Live model/provider execution — prohibited unless a later gate proves it can run with no credential or external call and receives separate approval.
- Mortgage-compliance validation — cases routed to compliance remain provisional pending qualified review.

## Context

The implementation starts from preserved local revision `4ec4144`. The canonical Rakazo checkout remains separate and untouched. The technical plans and answer key were frozen before execution; results cannot renegotiate them after the fact.

## Constraints

- **Security**: Synthetic-only; no PII, credentials, real identifiers, production paths, or external calls.
- **Authority**: Codex/CLI implements; a separate Claude model instance may review but cannot execute or override the deterministic verdict.
- **Isolation**: All changes remain in this dedicated Git worktree and local branch.
- **Compatibility**: Changes are additive and disabled by default; ordinary Rakazo behavior must remain unchanged.
- **Compliance**: LIQR-011, LIQR-012, and LIQR-013 are `PROVISIONAL_COMPLIANCE`.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Use a deterministic verifier as the authoritative technical gate | No second human reviewer exists | — Pending run evidence |
| Keep Claude in the reviewer slot only | Maintains the only available model-instance separation | — Pending review |
| Stop at the synthetic boundary | No qualified security/compliance reviewer exists | ✓ Locked |
| Execute sequentially inside a manually isolated worktree | Wave 1 plans overlap one contract file and Codex subagents lack automatic worktree isolation | ✓ Locked |

---
*Last updated: 2026-08-29 after isolated synthetic implementation approval*
