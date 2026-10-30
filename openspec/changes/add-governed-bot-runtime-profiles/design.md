# Design

## Context

### Scope and evidence

This is a planning-only change for upstream `elie222/rakazo` at `296fe50786197a62b94e3b5d4d48426396eae32c`, checked on 2026-10-30. The isolated branch is `spec/bot-profiles-learning-initiative`. Backlog **TASK-394** holds the owner's exact request and planning authorization. OpenSpec is newly initialized, so the capability specs are additions rather than modifications to a pre-existing specification baseline.

The product direction is a Rakazo fork with individually configurable persistent bots across web and mobile, Pi-backed profiles/extensions, governed learning and bounded initiative. Pots is a design reference. Hermes supplies learning/curation patterns. `oratis/LISA` supplies reflection and explicit goal/initiative patterns. Pi Pocket remains a separate application and deployment.

The research reports at `/home/phroggingphrog/projects/pi-bot/architecture-comparison.md` and `/home/phroggingphrog/projects/pi-bot/research_notes/Rakazo Jev memory backend/` used an older Rakazo baseline. They are supporting analysis, not a compatibility certificate. The current source overrides stale claims, including the earlier claim that Rakazo lacked Jev support.

### Checked current source

| Area | Current behavior and source seam | Consequence |
|---|---|---|
| Bot identity | `packages/db/prisma/schema.prisma` `Bot`: instructions, history, pending proposal, model/effort, disabled tools, computer, memory and MCP relations | Add a distinct persona and profile revision; do not invent a separate installation per bot |
| Runtime | `packages/adapters/src/pi-runtime.ts` constructs `Agent` directly; `packages/adapters/package.json` pins Pi agent-core/AI/telemetry at `1.3.0` | Native Pi coding-agent extension profiles are not already loaded |
| Prompt | `executor.ts`, `run-instructions.ts` `userTurnInstructions` and `run-context.ts` | Resolve a profile before prompt/tool construction; keep trust boundaries intact |
| Skills | `skill-tools.ts` `listAgentSkillRecords`, `AgentSkill` and `TaughtSkill` models; `docs/skills.md` | A reusable library is not a per-bot assignment; built-in/plugin skills remain immutable |
| MCP | `BotMcpServer`, `mcp-connector.ts`; worker stdio restrictions | Reuse server assignments, allowlists and owner checks instead of a second connector |
| Secrets/computers | `docs/bot-secrets.md`, `bot-secrets.ts`, `packages/db/src/computers.ts` | Profiles are not filesystem/cookie isolation; current shell visibility and shared computer behavior must be disclosed |
| Approval | `decision-auto-review.ts`, `jev-auto-review.ts`, `run-tool-gate.ts`, `run-tool-request.ts`, `docs/approvals.md` | Reuse existing action classification, immutable requests, owner confirmation and secret checks |
| Models | `run-model.ts` `resolveRunModel`, model roles and model-selection modules | Extend model roles and validate routes before execution; preserve pinned choices and account selection |
| Run ownership | `docs/run-execution.md`, `run-execution.ts`, executor ownership and `run-effects.ts` | Current starts dispatch directly after durable scheduling; workers recover periodically. Graphile handles maintenance/scheduling, not an alternate tool executor |
| Memory | `MemoryStore`, `SemanticMemoryProvider`, `run-tools-memory.ts`, `memory-context.ts`, `history-compaction.ts`, `docs/memory.md` | Preserve revisioned Markdown, source generations and optional providers; new retention must be explicit |
| Clear history | `packages/db/src/events.ts`, `apps/api/src/routes/threads.ts` | Invalidate prior-generation summaries and learning; clearing chat is not forgetting every saved durable fact |
| Initiative | `routine-watch.ts`, `run-routines.ts`, `job-reconciler.ts`, `run-notifications.ts`, `docs/routines.md` | Reuse deterministic fingerprints, routines, jobs, current ownership and notification settings |
| Client portability | `packages/contracts`, API routes, `packages/chat-ui`, mobile app, `docs/portability.md` | Shared backend controls need actual web/mobile UI work and old-client fixtures |

### External evidence and limits

- [Hermes Curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator) and [skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills): usage-aware agent-created skill maintenance, proposals and reversible archiving. This design does not copy its session-end dependence into an endless chat.
- [LISA README](https://github.com/oratis/LISA): reflection, desires and heartbeat/idle work are design references, not a runtime dependency or evidence of sentience. The local LISA snapshot has broken Git metadata and is not a verified upstream checkout.
- [Official Pi repository](https://github.com/earendil-works/pi) and [coding-agent package](https://github.com/earendil-works/pi/tree/main/packages/coding-agent): executable extensions, supported APIs, SDK and lifecycle. The locally available coding-agent declarations are version `1.2.3`, while Rakazo uses low-level Pi `1.3.0`; exact-release compatibility remains an implementation gate.
- [Hindsight](https://hindsight.vectorize.io/) and its [retain API](https://hindsight.vectorize.io/developer/api/retain): optional semantic recall/reflection integration. Verify installed OSS deployment capabilities, authentication and deletion/export behavior before enablement.
- Focused DeepWiki discovery returned [Agent Runtime (Pi)](https://deepwiki.com/elie222/rakazo/3.3-agent-runtime-(pi)), [Skills System](https://deepwiki.com/elie222/rakazo/4.4-skills-system) and [Background Jobs & Workers](https://deepwiki.com/elie222/rakazo/6.6-background-jobs-and-workers). The tool returned no search URL. Current source, not wiki freshness, controls this design.

No runtime probe, new dependency installation, migration, compatibility test or deployment occurred while drafting this change.

## Goals / Non-Goals

**Goals**

1. Each bot has an inspectable, revisioned identity and effective runtime profile while sharing Rakazo's infrastructure.
2. Bot capabilities are enforced by backend policy across direct, nested, extension, specialist and unattended calls.
3. Memory and skills improve through bounded, evidence-linked review, explicit promotion policy and rollback.
4. Owner-enabled goals give useful initiative with approvals, limits, quiet hours, recovery and low notification noise.
5. Existing clients, canonical chat, execution ownership and deployment remain usable; new integrations are optional.

**Non-Goals**

Model training, autonomous permission escalation, arbitrary untrusted tenant code, a public extension marketplace, wholesale runtime replacement, universal Pi extension compatibility, a separate public specialist chat, new communication channels, or changing Pi Pocket. Do not copy personality randomization or invented emotions as factual claims. Reflection records conclusions and evidence, not private chain-of-thought transcripts.

## Decisions

### 1. Keep one product, one transcript authority and one effect owner

```text
Web / Electron / native mobile / thin CLI
                    |
       Existing authenticated API + contracts
                    |
      Profile resolver + policy compiler
                    |
      Existing Rakazo run admission and ownership
                    |
      Optional constrained route selection
                    |
  AgentRuntime adapter (legacy Pi or profiled Pi host)
       |                 |                 |
 Tools/MCP/skills   Scoped memory     Private specialists
       |                 |                 |
 Existing action gate + effect journal + live revocations
                    |
       Existing canonical chat/event stream
                    |
  Bounded outcome review / goal checks / result delivery
        through existing jobs and normal run creation
```

Postgres remains authoritative for bots, profiles, messages, approvals, source generations, learned artifacts and run/task states. Revisioned Markdown remains a readable curated memory layer. A semantic provider indexes authorized derived knowledge; a continuation store may hold private execution checkpoints. Neither becomes the user's transcript, authentication system or independent active scheduler.

Rejected alternatives: transplant Pots' SQLite/gateway ownership; launch a second always-on agent per bot; give extensions an ungoverned filesystem-based session store. They introduce competing ownership and privacy boundaries without solving the requested profile management.

### 2. Make the profile a versioned aggregate, not duplicate configuration authority

Proposed logical records, with names finalized during schema work:

| Record | Responsibility |
|---|---|
| `BotProfile` / `BotProfileRevision` | Current revision pointer, persona, explicit policy selections, actor/reason and immutable redacted revision snapshots |
| `ExtensionArtifact` / `BotExtensionAssignment` | Operator-approved digest, source/license/API version/capability metadata; bot version pin and validated nonsecret settings |
| `BotSkillAssignment` | Explicit library selection or bot-private learned artifact access; preserve a visible legacy-library mode |
| `LearningPolicy` / `LearningReview` / `LearningProposal` | Trigger/limits, source window, durable review identity, candidate lifecycle, expected target revision and applied result |
| `MemoryEvidence` / `MemorySyncOperation` | Authorized source references, type/scope/generation, corrections, suppressions and provider ingestion/deletion reconciliation |
| `BotGoal` / `GoalOccurrence` / `DeliveryIntent` | Enabled objective and limits, unique trigger occurrence, run/result references and deduplicated communication |
| `RunProfileSnapshot` / `RunRouteDecision` | Effective profile/resource versions, policy hash, selected route and fallback evidence |
| `SpecialistTask` | Optional private continuation identity, parent/generation, narrowed authority, lease-related metadata, budget and result state |

Use existing storage/audit primitives where they already satisfy these responsibilities rather than automatically creating a table for every logical record. Tenant keys, unique idempotency constraints, foreign keys, timestamps and retention policy are mandatory. Arbitrary free-form JSON is not an authorization schema.

Keep existing `Bot` columns authoritative for current model overrides, disabled tools, computer and MCP references during expand-first rollout. The resolver reads those fields into the effective profile; new settings have their own revisioned records. All supported old and new mutations must update the audit/revision representation transactionally. A later schema cleanup is not part of this change unless required for consistency.

Persona is a separate document/field. `SOUL.md` import/export maps to it. Existing operational instructions are copied unchanged; there is no automatic model-driven persona extraction. Prompt assembly labels persona, owner instructions, curated memory, candidate knowledge and untrusted source content distinctly.

Updates use an expected revision. Restore creates a new revision after resource validation. A run snapshots the effective configuration once; live denies, membership, credential revocation and extension withdrawal override the snapshot before subsequent actions. Refresh memory at explicit model-turn boundaries, but do not silently change persona/model/tool assignment during an active run.

New bots use explicit skill assignment; existing bots retain legacy-library access until the owner opts into selection. Platform-required safety behavior is not a removable skill or extension.

### 3. Add a bounded Pi extension host behind `AgentRuntime`

Preferred implementation: add a `PiProfileRuntime` adapter using the official embedded coding-agent SDK and a custom resource loader, while retaining the current direct-`Agent` adapter for legacy profiles. Use an in-memory session projection hydrated from Rakazo's canonical history; persist only product-owned state through Rakazo. The official SDK is a host implementation detail, not a second active session service.

The implementation must prove that the selected exact Pi release can accept product-managed models/authentication, explicit tools, resource loading, cancellation, events and non-file session projection. Do not install a mismatched SDK beside agent-core and assume nominal API names imply compatibility. If the exact release cannot preserve these constraints, update this design with the proven host mechanism before enabling extensions. Do not silently fall back to raw extension execution or a new daemon.

Host construction must disable implicit home/repository extension discovery, default filesystem skills, stock ungated shell/file tools, local auth-file discovery, independent compaction and independent session persistence. Only profile-selected artifacts and product-owned tools are loaded. Cross-bot runtime objects, event buses and mutable state must not be shared. Synchronous trusted code can still block a Node process; hook timeouts cannot sandbox it.

Initial compatibility matrix:

| Pi surface | Initial treatment |
|---|---|
| Tool registration with standard results | Supported through a namespaced tool registry and normal policy/effect gate |
| Lifecycle observation and prompt/context transformation | Supported with deterministic ordering, bounded hooks and explicit trusted/untrusted context rules |
| Tool gates and supported nested tool execution | Supported; extensions may narrow behavior but cannot bypass the mandatory final product gate |
| Nonsecret settings and state | Bot-scoped, revisioned settings and product-backed bounded state |
| Commands | Headless product commands through the shared API; no terminal ownership |
| Model/effort changes | Requests pass route/model validation; explicit choices and live limits remain authoritative |
| Provider or MCP registration | Adapter to an existing approved connection, or explicit unsupported status; never an ungoverned credential/connection path |
| User/custom messages | Standard serializable content through chat/delivery policy, with source attribution |
| Terminal widgets, keybindings and renderers | Unsupported unless a documented plain/headless fallback makes the operation functional |
| Independent session switching, fork/resume, raw auth mutation, background process ownership | Unsupported |
| Raw Node/filesystem/network access in extension code | Operator-trusted code execution, not enforceable bot isolation; no untrusted tenant artifacts |

Operator approval records provenance, immutable artifact digest, license, compatibility and declared required capabilities. A bot owner can assign versions, not execute install commands. Extension package updates never float automatically. A rollback validates the old artifact and current denies. Pinned versions needed by active runs stay available; withdrawal cancels affected work.

Tool name collisions fail validation; no shadowing of built-ins or another extension. Mandatory safety-hook failure blocks the affected action. Optional observation-hook failure is visible and may disable that observer for the run without silently removing policy. Startup, asynchronous hooks, output sizes, state writes and cleanup have explicit bounds. Cancellation and cleanup are idempotent; extension-owned timers may not schedule independent bot work.

This trust model does not prevent malicious operator-approved code from using Node directly. Supporting untrusted code requires a separate security design and is excluded here.

### 4. Compile one capability policy and apply it at every supported entry point

Resolve authorization as the intersection of current space membership, deployment/operator constraints, bot assignments, task-specific grants and live revocations. Prompt catalogs are a view of this policy, not its enforcement mechanism.

Apply checks to tool lookup and execution, catalog wrappers, tool aliases, commands, nested calls, extension APIs, skill read/write, MCP resolution, background work and specialist dispatch. Continue using `run-tool-gate.ts`, `planActionGate`, current decision review and the effect journal; do not replace existing deterministic source-trust or dangerous-action rules with a model judgment.

Skills are knowledge, not permission grants. Keep reusable library records distinct from assignments and bot-private learned forks. Library creation does not automatically expose a skill to all bots. Shared publication and edits require owner review. Bot disablement of a tool wins over an extension or skill requesting it.

Use existing credential vault references, approved account selection, destination checks and browser handoff. Do not copy secrets into profile JSON, prompts, extensions settings, exports, logs or learned artifacts. Existing bot-secret functionality may deliberately expose a value in the bot computer; disclose that rather than promising secrecy from the shell. Same-process trusted extensions are not isolated from server secrets by profile selection.

Computer sharing is explicit. Retain existing shared/dedicated modes and concurrency rules. A bot-specific home is not proof of private browser sessions or files. Changing sharing mode requires explicit owner action and existing provisioning behavior, not automatic computer duplication.

### 5. Separate authoritative evidence, curated memory and semantic recall

Memory types:

- Transcript/events and tool results: source evidence subject to history generation and retention.
- Curated private/shared Markdown: revisioned durable notes with explicit sharing.
- Derived memory: lessons with source references, statement type, review status and correction lineage.
- Provider index: scoped retrieval/reflection derived from approved content, with visible capability and synchronization status.

The resolver computes authorized namespaces before querying any provider. Provider scope is defense in depth; returned records are filtered against current local authorization and suppression state before prompt inclusion. No cross-bot sharing occurs just because bots belong to one account. Existing shared memory remains shared until the owner changes it; new learned memory defaults private.

Add bounded run-start and model-turn freshness checks so saved corrections take effect in one continuous chat. Remove the design dependence on having already compacted history before semantic recall. Keep explicit prompt budgets and source labels; unreviewed proposals do not become authoritative memory merely by appearing in context.

Use stable source identities and a durable synchronization outbox for provider writes/deletes. Before retaining or promoting, recheck source generation, scope, policy and suppression. A forget operation suppresses local use immediately, marks known derivatives and schedules provider deletion. A late provider retain after deletion stays filtered and schedules cleanup. Retry with bounded backoff and visible pending/failed status. Do not claim a remote deletion completed unless verified.

Clearing chat invalidates prior-generation conversation summaries, queued learning and continuing specialist context. It does not implicitly remove deliberately saved durable memory. Provide a separate reviewed forget action. Correction records suppress superseded variants and prevent relearning from unchanged evidence. Account/bot deletion propagates scoped cleanup; tombstones contain the minimum identifiers needed for reconciliation, not unnecessary deleted content.

Optional Hindsight adapter: prefer its published HTTP API or a vetted official SDK only if necessary. Map bot and authorized shared scopes to isolated provider entities/banks through deployment credentials; never take arbitrary bank identifiers from a model. Use recall for approved scopes, retain approved derived artifacts, and bounded reflect as evidence for a proposal. A reflection answer is not owner authority. Verify the actual OSS deployment's authentication, deletion/export, metadata filtering and asynchronous ingestion behavior before enabling writes. Local Markdown plus transcript search remains useful with no provider or during provider failure.

Do not backfill whole histories to a remote provider automatically. Explicit opt-in backfill is scoped, budgeted, checkpointed, cancellable and disclosed as data egress. Export labels provider coverage and excludes secrets.

### 6. Make learning a durable artifact workflow

Modes: `off`, `proposals-only`, `automatic-private`. New background learning is off for existing bots; owners choose triggers and limits. Direct existing memory tools remain governed by existing behavior unless the owner enables the new promotion policy.

```text
Eligible completed source window
  -> durable review claim and bounded evidence
  -> structured memory/skill/goal candidates
  -> deterministic validation + optional semantic qualification
  -> pending owner review OR narrow configured private promotion
  -> expected-revision write + audit + provider synchronization
```

Review identity includes bot, source window/generation, policy version and reviewer version. A duplicate trigger reconciles the same review. The review uses a configured model role and selected authorized evidence; it is not an unrestricted bot with all tools. It can inspect evidence and draft artifacts, not send mail or change infrastructure.

Candidate state machine: pending -> approved -> applied; pending -> rejected; any pre-application candidate -> conflicted/superseded/failed when references no longer validate. Promotion records the applied revision transactionally and uses a unique promotion key. Retrying cannot apply twice. Owner decisions require current authorization and expected candidate/target revisions.

Automatic promotion is limited to evidenced private memory or private instructional skill changes within explicit policy. Persona, operational instructions, shared knowledge, code/scripts, extension installs/settings that change authority, credentials, permission grants and enabled goals/routines always need authenticated owner confirmation. Low confidence or missing evidence leaves a candidate pending. Text from tools, websites and subagents never counts as owner permission.

Deterministic checks cover schema, allowed type, references, source generation, scope, revision, size, secret exclusion, permissions and idempotency. Free-form semantic quality needs an explicit versioned evaluator/rubric and reviewed calibration examples under repository instructions; regular expressions or a single vague confidence score are not a meaning validator. Evaluator errors cannot authorize promotion. A failed workflow is not saved as proven success.

Track skill uses and outcomes. Mark stale, do not assume unused means useless. Do not archive skills referenced by profiles, goals or routines, including paused ones. Installed/plugin/built-in skills remain immutable. Consolidation defaults to proposals-only; a private learned fork records origin. Archival is reversible and no automatic permanent deletion is permitted.

Reflection tools request the same lifecycle: request bounded review, inspect candidates, propose a lesson or goal and read status. No tool owns an independent learning loop. Reflection of review-only output cannot recursively retrigger review. Budgets cap calls/tokens, frequency, source size, candidates, retries and wall time. Disablement, source clearing or revoked scope prevents promotion even after a model call finishes.

### 7. Model initiative as enabled goals over existing routines

A goal contains objective, source/target scope, permitted action subset, watch/schedule/idle trigger, timezone and quiet hours, budget, expiry, completion criteria and enabled state. A model-generated desire is only a disabled goal proposal. There is no new fictional personality subsystem or self-authored authority.

```text
Schedule / authorized event / idle review
  -> enabled, due, fresh, unexpired, within limits?
  -> deterministic fingerprint / duplicate and cooldown checks
  -> optional bounded wake decision
  -> normal Rakazo run with goal snapshot and narrowed policy
  -> result and delivery intent in durable storage
  -> one communication gate -> existing canonical chat + notification
```

Reuse current routine watches and scheduling. First observation establishes a baseline. No change normally means no model task and no message. Existing routines keep their behavior unless opted into the new goal policy. Missed occurrences have explicit skip/coalesce/bounded catch-up semantics; recovery cannot create a catch-up storm.

Check per-goal and per-bot budgets before dispatch and protected steps. Use concurrency-safe reservations and reconcile measured usage afterward. Hard monetary caps require known price; otherwise use hard token/call/time limits and mark cost unknown. Approval waits release active execution resources. Interactive runs retain current computer priority/concurrency behavior; no extra browser or computer is created to evade contention.

Goal enablement is a standing instruction only within its declared scope. Existing approval modes, blocked operations, trusted-source requirements and immutable action hashes remain authoritative. Sending, purchasing, deleting, changing access or production actions outside explicit owner grants must wait or fail closed. A read-only goal cannot authorize its own write tools.

All proactive user messages, including direct message tools, pass the same policy gate for quiet hours, cooldown, useful-change requirement, channel preferences and message allowance. Store task results separately from delivery intents. Commit results and delivery identity together; use stable IDs to reconcile repeated dispatch. Local logical delivery is deduplicated; external systems may deliver at least once, and uncertain effects are not blindly replayed. Silent runs remain visible in activity, not as repeated chat noise.

Pause/cancel/expiry, bot archival, membership loss and chat-generation changes stop future work and invalidate pending actions as appropriate. Resume revalidates resources and current budgets. Owners can explain a wake, inspect limits and stop it from mobile or CLI.

### 8. Reuse Jev for constrained optional routing, not authority

Existing Jev integration is action auto-review through `DecisionAutoReviewProvider`/`JevAutoReviewProvider`. Add separate optional routing, learning-review and wake-decision roles through current provider/connection abstractions; do not hard-code a new hosted vendor key or introduce conflicting model configuration.

Route precedence:

1. Persisted route for a resumed run.
2. Explicit authorized run, routine or specialist choice.
3. Optional profile route classifier for eligible unpinned work.
4. Existing member/bot/deployment resolution, subject to current credential policy.

Backend code enumerates labels mapped to fixed tuples: provider/model connection reference, supported effort and inline/background/authorized specialist execution mode. Exclude unavailable modes before classification. Send minimal authorized evidence with a versioned rubric. Decision output is one label, never an endpoint, credential, tool grant or plan.

At the seam before final `resolveRunModel`, validate protocol, credentials/account, media/tools, context budget, effort support, endpoint safety, tenant and spend policy. Commit the route and policy version so retry/resume does not pay for another classification. Invalid output or timeout falls back deterministically to existing configured resolution, which must pass the same checks. If it cannot, fail with a configuration error rather than selecting an arbitrary account or model.

Background execution is a run attribute; do not change a user trigger into a hidden routine trigger. Existing `docs/run-execution.md` says user events determine foreground transcript visibility. Route changes must preserve that admission and event linkage.

Approval and routing remain independent. A route cannot approve the action it chooses. Record classifier/model, selected and executed tuple, fallback reason, timing and actual usage where available. Do not infer missing cost or claim cheaper/better routing without evaluated examples.

### 9. Add durable specialists only behind a conformance-gated adapter

Keep current short-lived `run_subagent` behavior by default. Some work may need to continue after the parent turn, so the optional mode has a private `SpecialistTask` and result-reconciliation lifecycle.

The task records parent request/run, bot, profile revision, history generation, narrowed capabilities, model choice, workspace constraints, budget, checkpoint and cancellation state. It is not a new public bot identity or chat. Authority is the intersection of current bot policy, parent snapshot and task subset. Child recursion and concurrency are bounded.

Rakazo claims and cancels tasks through its existing ownership mechanisms. Pi Durable is a candidate for checkpoint/resume, not an additional active lease owner, transcript or side-effect executor. All tools must still enter the current action gate/effect journal. Stable task and effect identities must survive the two stores' commit boundary. Do not assume that both systems having replay primitives proves compatible at-most-once effects.

Require a prototype that kills workers before/after claim, checkpoint, approval, external dispatch, effect commit and result delivery. If the adapter cannot prevent a stale executor or reconcile uncertain effects, it remains disabled and current short-lived specialists still satisfy the core release.

Result commit and delivery have unique identities. A late result from a cleared generation is not delivered or used for learning. Cancellation persists while workers are offline and propagates to children. Any continuation database remains an implementation detail with explicit backup/retention and no copied credentials; no extra service or deployment is assumed by this plan.

### 10. Use one API for clients, CLI and portability

Extend shared contracts and existing authenticated API procedures for effective profile/revisions, validation and diff/apply, compatible catalog/assignments, learning policy/candidates, memory evidence/status and goal control. Endpoint names follow existing conventions during implementation. All mutations require expected revisions/idempotency where relevant. Operator installation endpoints remain a distinct authority from bot-owner assignments.

Web/Electron and native mobile need real controls for the full profile and review lifecycle. Reuse current settings/navigation/components and accessibility conventions; do not introduce a UI framework. Add translations, touch/focus states and explicit empty/loading/conflict/error/unsupported views. Operator package installation is not a mobile upload feature. Terminal-only extension widgets do not become custom mobile UI automatically.

The thin CLI uses the same API and current authentication, with redacted JSON and human output, validation/diff previews and nonzero failure codes. It does not edit Postgres, production config, data files or start a local parallel bot. Credential login follows current secure handoff, never token paste into profile files.

Integrate portable profiles with current export/import. Bundle schema version, persona, permitted nonsecret settings and resource references; omit histories, memories, cookies, credentials and artifact code by default. Import previews unresolved references and disabled goals/capabilities; validation and authorized rebinding happen before activation. A clone receives new bot/chat/private memory identities.

New APIs are additive/versioned, but strict enum and message schemas can still break older mobile clients. Add explicit capability negotiation and tested legacy projections/fallback standard messages. Older partial updates leave unknown profile fields untouched. Avoid new run triggers or required custom chat blocks for basic use.

## Risks / Trade-offs

| Risk | Mitigation and honest boundary |
|---|---|
| Extension host expands server trust | Operator-vetted immutable artifacts only; explicit compatibility and privileged-host disclosure; no claim of sandboxing trusted Node code |
| Full coding-agent SDK changes behavior | Separate adapter, exact-version conformance, explicit resources/auth/tools, in-memory projection and legacy path; no second persistence authority |
| Learning amplifies errors or injection | Evidence types, reviewed promotion policy, deterministic authority checks, calibrated semantic validation, correction/suppression and bounded retries |
| Endless chat serves stale facts | Run/turn-boundary freshness and correction precedence; avoid session-end-only learning |
| Shared library/memory leaks across bots | Explicit selection modes and server-side scope enforcement on reads and writes; cross-owner fixtures and cache revocation tests |
| Remote retention cannot prove erasure | Immediate product suppression, durable reconciliation and truthful pending/failed deletion/export status; default no bulk transcript upload |
| Autonomous work creates cost or noise | Disabled goals by default, deterministic watches, budgets, quiet hours and one communication gate |
| Two durable stores disagree | Optional adapter, stable identities and fault-injection conformance; no automatic resend of uncertain effects |
| Rollback weakens policy | Drain/hold profile-required work, kill switches and capability-aware claiming; no fallback to legacy execution for a restricted profile |
| Broad implementation scope | Dependency-ordered slices with acceptance evidence; optional integrations stay disabled until their gates pass, not silently treated as complete |

## Migration Plan

1. **Baseline and fixtures.** Pin/recheck upstream revision, capture current API/mobile/model/approval behavior, and verify candidate dependency provenance and exact APIs. No production changes occur in planning.
2. **Expand storage/contracts.** Add nullable/defaulted records and API fields. First deploy a capability-aware admission/recovery release with every new feature off, and verify that all active workers honor the new required-capability/version predicate. This becomes the minimum mixed-version and rollback baseline for profile work. A pre-guard binary cannot safely coexist with restricted work; drain/hold that work before any rollback to such a binary. Keep legacy work processable throughout.
3. **Idempotent legacy profile projection.** Preserve instructions, model defaults, skill-library mode, MCP/computer and memory sharing. New learning, routing, semantic writes, initiative and durable tasks are off. Backfill cannot reset owner edits.
4. **Profile and enforcement foundation.** Ship resolver, revision/conflict behavior, snapshots, live revocation and policy checks. Verify direct and indirect tool paths before offering executable assignments.
5. **Extension cohort.** Enable the compatibility-gated host for a small operator-approved artifact set. Test legacy parity, failures, cancellation and secret boundaries through API/worker execution before widening assignments.
6. **Memory/learning/initiative.** Enable local proposals-only learning first, then explicit private promotion and disabled-goal proposals. Pilot Hindsight only with consent and verified deletion/egress. Enable selected bounded goals after source and delivery tests.
7. **Routing and optional continuation.** Start routing with evaluated labels and pinned default fallback. Enable durable specialists only after ownership/effect conformance, independently of the core profile release.
8. **Clients and rollout verification.** Ship shared API/CLI/web/mobile controls and old-client compatibility. Run the release suite once before release, inspect mobile/desktop screenshots and record UI audit results. An authorized deployment must use the existing service/data path with recorded build identity and undo.

**Undo:** disable affected feature dispatch and new promotions, persist cancellation/hold state, revoke assignments if needed, drain supported active work and hold profile-required jobs before binary rollback. Keep additive tables and revisions for audit; do not drop them as routine rollback. Restore an earlier profile as a new validated revision. Restore local learned artifacts via revisions and suppress/delete unwanted semantic entries with tracked remote status. Never let an old worker execute work whose policy it cannot enforce. Production rollout, server moves/deletes and irreversible external actions require their own applicable owner authorization.

## Verification Strategy

| Area | Required proof |
|---|---|
| Profiles | Legacy equivalence; conflict/restore; snapshot stability; old-client edits; source-of-default inspection |
| Capabilities | Cross-bot/space denial; raw/alias/catalog/nested calls; skill reads/writes; MCP; revoked credentials; shared vs dedicated workspace disclosure |
| Extensions | Exact-version API matrix; approved tool/hook examples; incompatible and terminal-only failures; lifecycle/cancellation; collision; state separation; pinned-artifact recovery |
| Memory | Pre-compaction recall; continuous-chat freshness; budgets; scope/cache revocation; corrections; stale generations; late retains; deletion/export status and no-provider operation |
| Learning | Eligible windows, evidence/outcome fidelity, reviewed semantic calibration, conflicts, duplicate promotion, rejection dedupe, immutable skills, no recursive review, disable/cancel and archive restore |
| Initiative | First baseline/no-change, duplicate events, expiry/timezones/DST, quiet hours, direct-message gate, budget concurrency, approval waits, pause/resume, bounded catch-up and result/delivery crash points |
| Routing | Explicit choice precedence, protocol/credential/media/effort validation, one committed decision, timeout/invalid fallback, no trigger rewriting and honest usage |
| Specialists | Offline cancellation, lease/fence loss, scoped children, computer contention, checkpoint/effect uncertainty and single logical result after recovery |
| Product/release | Strict older mobile fixtures, cursor streaming/cancel/approval, migration and old/new worker overlap, account portability, screenshots, exact deployed build/URL/action evidence and exercised undo |

Prefer existing Vitest/testkit and runtime conformance seams. Use deterministic fakes for policy/lifecycle tests and separately verify actual optional provider/runtime adapters before claiming integration success. Tests with a fake model prove only the fake-model path. Measure latency, cost, memory and routing quality before claiming improvements; do not attach unrelated totals to one feature.

## Open Questions

These are implementation discovery items with safe defaults, not invitations to expand scope or stop between every phase:

- Which exact Pi coding-agent release matches the current low-level dependency family and exposes the required host APIs? Default: legacy runtime stays active; no incompatible artifact can be enabled.
- Can the chosen SDK disable every implicit local resource/auth/persistence path while preserving current provider/account semantics? Default: extension activation fails closed until conformance is proved.
- Which installed Hindsight OSS version and namespace/authentication layout will be used? Default: local memory only; no new service or remote retention is provisioned by this plan.
- Can Pi Durable fit Rakazo fencing and effect reconciliation without a second active owner? Default: short-lived specialists only; optional continuation remains disabled if not proved.
- What numerical limits and notification windows fit each bot? Default: new background capabilities off; enablement requires a documented finite deployment default or explicit owner values, never unlimited.
