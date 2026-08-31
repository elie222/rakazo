# Phase 1 Context

<decisions>

- The phase is authorized only for isolated synthetic implementation and offline scripted/fake testing.
- Codex/CLI is the implementation actor. Claude may perform a separate advisory review but must not execute or override the verifier.
- The deterministic verifier owns ACCEPT, REJECT, and INVALID_PACK.
- The 20 expected outcomes are frozen before execution and cannot be renegotiated after results are known.
- LIQR-011, LIQR-012, and LIQR-013 must be labeled PROVISIONAL_COMPLIANCE.
- No human independent or qualified security/compliance reviewer is available; do not imply otherwise.
- No production/redacted data, credentials, connectors, external calls, outbound actions, deployment, or synthetic-to-real promotion.
- The local Pi campaign is not run if it requires a provider credential or external model call.
- This worktree is isolated from the canonical Rakazo checkout and must not modify it.

</decisions>
