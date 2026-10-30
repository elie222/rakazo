# Proposal

## Why

Rakazo already provides persistent bots, a canonical chat per bot, cross-platform clients, durable run ownership and action approvals. It needs an explicit per-bot runtime profile and governed learning and initiative so bots can become individually useful without sharing unintended capabilities or creating a second execution authority.

## What Changes

- Add revisioned bot profiles with separately editable persona/SOUL, operational instructions, selected skills, approved Pi extensions and their settings, model/routing policy, memory/learning policy and initiative limits. Preserve existing bot settings and make the effective configuration inspectable.
- Add a trusted executable-extension catalog and a Pi extension-host integration behind the existing runtime boundary. Installation requires deployment-operator approval; bot owners assign compatible installed versions. Publish a supported API/lifecycle matrix, reject unsupported mandatory behavior and never claim that a profile is an OS sandbox.
- Enforce bot capability assignments in discovery and execution, including direct tools, catalog calls, nested calls, skill reads/writes, MCP, specialists and background work. Reuse existing approval, credential, computer and space boundaries.
- Add provider-neutral, provenance-aware memory governance and an optional Hindsight adapter. Keep Postgres transcripts and revisioned Markdown authoritative; make retrieval freshness, corrections, export, forgetting and deletion status explicit.
- Add Hermes-inspired outcome review and skill curation plus LISA-inspired reflection and bounded goals. Generate evidence-linked proposals; validate and version promotions; require owner approval for identity, shared knowledge, executable capabilities and authority changes. Learning does not train model weights or require a new chat session.
- Add opt-in initiative using existing routines, deterministic watches and run recovery. Goals declare permitted actions, budgets, quiet hours, expiry and stop conditions. Deliver useful updates through the existing bot chat, with deduplication and notification controls.
- Add optional model/effort/execution routing through the existing decisions-provider seam, including Jev. Keep routing independent of action approval. Add optional private durable specialist continuation only where a task must outlive its parent turn; Rakazo remains the ownership and effect authority.
- Add shared management APIs, a thin authenticated CLI, web/Electron and native mobile controls, safe profile import/export, audit visibility and staged migration/rollback coverage. Existing installations retain their behavior until new features are enabled.

## Capabilities

### New Capabilities

There are no existing OpenSpec capability specs in this newly initialized repository. These additions describe new behavior and its obligations to preserve current behavior; they do not imply that existing Rakazo primitives are absent.

- `bot-runtime-profiles`: revisioned persona and runtime settings, effective configuration, snapshots, templates and safe portability.
- `pi-extension-profiles`: trusted extension installation, bot assignment, compatibility, lifecycle, state and failure handling.
- `bot-capability-policy`: backend-enforced tool, skill and MCP assignments with workspace, credential and delegated-authority boundaries.
- `governed-bot-memory`: scoped evidence, freshness, provider-neutral recall, optional Hindsight, corrections and deletion/export semantics.
- `bot-learning-reflection`: bounded outcome review, learning proposals, controlled promotion, reversible skill curation and reflection tools.
- `bounded-bot-initiative`: explicit goals, wake decisions, budgets, notifications, approvals and durable delivery.
- `run-route-selection`: constrained optional decisions-based routing, precedence, validation, pinning, fallback and separate accounting.
- `durable-specialist-work`: optional private continuation, inherited authority, recovery, cancellation and result reconciliation.
- `bot-profile-management`: common API and CLI behavior, cross-platform controls, human review and import/export previews.
- `profile-execution-compatibility`: canonical-chat preservation, run/effect authority, rolling upgrades, observability, rollout and rollback.

### Modified Capabilities

None. The repository had no baseline OpenSpec specs at initialization. Existing source contracts remain authoritative unless this change explicitly introduces additive behavior.

## Impact

**Baseline:** upstream `elie222/rakazo` commit `296fe50786197a62b94e3b5d4d48426396eae32c`, checked on 2026-10-30. Earlier research used `60c8548f8b468ffe462a5bcfea1f3deb3ba94058`; current source takes precedence. This draft is planning only. It contains no application changes, compatibility proof or deployment authorization.

Affected areas include `packages/{contracts,core,db,adapter-kit,adapters,memory,chat-ui,testkit}`, `apps/{api,worker,web,mobile}`, the desktop-hosted web UI, existing account portability and documentation. New tables and optional fields must support old and new API/worker versions during rollout. New enum values and message blocks need explicit compatibility handling, not an assumption that additive JSON is automatically safe.

Dependency candidates are the official Pi coding-agent extension host, optional Hindsight integration through its published API, and optional Pi Durable continuation. Exact versions require provenance, API and license checks before addition. No new dependency is installed by this proposal; no hosted vendor becomes mandatory. Existing generic model/connection configuration must express new model roles.

**Non-goals:** replacing Rakazo's executor, moving user chat to a second runtime, transplanting Pots/Hermes/LISA wholesale, changing model weights, unrestricted self-modification, arbitrary tenant code execution, a public extension marketplace, new messaging channels, a second deployment, or changing Pi Pocket. Full compatibility with terminal-only or process-owning Pi extensions is not promised.

**Delivery:** implement the tasks in dependency-ordered, independently testable slices. Ship core profiles and enforcement first, then extension support, memory/learning/initiative, routing and clients. The optional Hindsight and durable-specialist phases remain part of the plan but stay disabled unless their conformance gates pass and their configuration is enabled. A new request is required to start implementation.
