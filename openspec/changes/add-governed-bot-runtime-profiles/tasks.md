# Tasks

Implementation is in progress under the owner-approved bounded persona scope. TASK-394 records the current authorization: continue isolated implementation and prepare a pull request; do not deploy, merge, or push to the default branch. The full design remains incomplete. Keep overall status on TASK-394 and use this file as the implementation checklist.

### Verified persona regression milestone

- [x] Reproduce and correct the routine-backoff transaction assertions without weakening the routine lock checks (`6e4c3a5`, typed spy follow-up `15a2cd8`).
- [x] Supply scoped bot/profile delegates and transaction clients in legacy executor fixtures (`86da6a8`). Both previously failing files pass all 155 tests.
- [x] Run the broader relevant regression set: 995 tests pass in 40 files. Adapter, API and web TypeScript checks pass.
- [ ] Complete the full design and integrated release gates below. The focused persona result does not complete extension, learning, initiative, routing or specialist requirements.

The setup error handler logs the sanitized original error before it queries the failure streak. A second database failure in that query can replace the propagated exception. Missing fixture methods caused the observed failures. No production error-handling change forms part of this milestone.

The sequence below implements the whole agreed design. Groups 10 and 13 include optional integrations: complete their discovery and conformance work, but keep activation disabled if a gate fails. Record a specific blocker and reconcile the design/specs rather than calling an unverified integration complete or substituting another product silently. Exact dependency versions and deployment defaults are technical discovery items; changing the agreed trust or product scope requires owner review.

## 1. Baseline, contracts and dependency discovery

- [ ] 1.1 Recheck the implementation checkout against upstream and record its exact revision and relevant drift from `296fe50786197a62b94e3b5d4d48426396eae32c` in this change and the board; verify cited runtime, approval, memory and run-ownership seams still exist.
- [ ] 1.2 Capture existing bot, chat-stream, cancellation, approval, model-account, skill-library and routine API fixtures including a supported older mobile client; verify they pass against the unmodified baseline using the existing testkit.
- [ ] 1.3 Vet the official Pi coding-agent package, exact compatible version, repository provenance, license and transitive impact without adding it yet; verify SDK declarations and source support explicit resources, product auth/tools and in-memory session projection.
- [ ] 1.4 Produce the exact extension API support matrix and approved conformance examples, including unsupported terminal/session/process APIs; verify every proposed supported surface maps to an existing product policy/lifecycle seam.
- [ ] 1.5 Define shared schemas for profile revisions, nonsecret settings, resource references, evidence/proposals, goals, route labels and runtime capability negotiation; verify round-trip, unknown-field and legacy-decoder fixtures.
- [ ] 1.6 Specify finite deployment defaults for review, wake, budget, retries, output sizes and compatibility behavior with new features off; verify settings validation rejects unlimited or unsupported enabled configurations.
- [ ] 1.7 Document the selected trust boundary, dependency evidence and legacy preservation rules in existing runtime/customization docs; verify every unsupported feature has an explicit error or documented fallback rather than a silent no-op.

## 2. Expand-first storage and legacy projection

- [ ] 2.1 Add additive profile/revision/persona storage and immutable audit metadata with owner/space keys and expected revisions; verify migration tests on empty and populated databases plus revision uniqueness.
- [ ] 2.2 Add approved extension artifacts, per-bot extension/skill assignments and the explicit legacy-library selection mode; verify referential, owner-scope and immutable-version constraints.
- [ ] 2.3 Add durable learning review/proposal/evidence/synchronization records with stable source, generation and promotion identities; verify duplicate inserts and cross-scope references fail safely.
- [ ] 2.4 Add goals, occurrence and delivery-intent state or extend existing routine records where equivalent; verify unique occurrence/delivery constraints and required bounded-policy fields.
- [ ] 2.5 Add run profile snapshots, route-decision metadata and required executor capabilities without breaking old schemas; first establish a guarded admission/recovery baseline with new features off, then verify supported mixed versions exclude incapable workers and pre-guard binaries cannot coexist with restricted work.
- [ ] 2.6 Implement idempotent profile projection/backfill preserving current bot instructions, model/MCP/tools, computer, memory sharing and routine settings; verify repeat runs do not duplicate records or reset owner edits.
- [ ] 2.7 Document expand/backfill/hold/rollback procedures in existing deployment docs; verify a migration rehearsal preserves legacy fixtures and does not require dropping new records for binary rollback.

## 3. Profile resolution, persona and revision behavior

- [ ] 3.1 Implement an effective-profile resolver using existing settings as their current authority, with defaults/provenance and unavailable-resource diagnostics; verify explicit and inherited settings against baseline fixtures.
- [ ] 3.2 Implement expected-revision profile updates, redacted diffs and restore-as-new-revision; verify concurrent edits, rejected restores and stale resource references.
- [ ] 3.3 Route existing supported bot-setting mutations through consistent revision/audit updates; verify old-client partial edits preserve new fields and never restore duplicate stale values.
- [ ] 3.4 Add separate persona/SOUL prompt composition and import mapping without rewriting existing operational instructions; verify exact legacy prompt preservation and distinct trust labels for memory and source content.
- [ ] 3.5 Snapshot profile/resource versions at run start and rehydrate them on resume; verify a mid-run ordinary profile edit affects only later runs while live revocations still take effect.
- [ ] 3.6 Implement profile clone/template and portable nonsecret representation with new bot/chat/private-memory identities; verify no credentials, browser state, histories or enabled imported goals are copied by default.
- [ ] 3.7 Document precedence, active-run behavior and revision restoration in existing bot docs; verify worked examples match resolver and conflict tests.

## 4. Backend capability policy and isolation

- [ ] 4.1 Compile the intersection of deployment, owner/space, bot and task-specific permissions with live revocations; verify cross-owner, cross-bot, removed-member and explicit-deny fixtures.
- [ ] 4.2 Apply the policy to tool discovery and execution, aliases, catalog resolution, nested calls and commands before dispatch; verify guessed raw names and wrapper calls cannot bypass a disabled tool.
- [ ] 4.3 Enforce skill selection on catalog, read, create, update, archive and publication paths while preserving visible legacy-library mode; verify unassigned reads fail and bot-private learned skills do not appear to other bots.
- [ ] 4.4 Bind profiles and future extension MCP requests to existing server assignments, allowlists and current server revisions; verify execution denial and approval invalidation after assignment/server changes.
- [ ] 4.5 Preserve current vault/account selection and destination checks for credential references; verify exports/settings/logs contain no secret values and revocation blocks later managed requests.
- [ ] 4.6 Apply narrowed authority and current denies to existing subagents, routines and internal model work; verify skills, memories and model labels cannot grant a capability.
- [ ] 4.7 Expose shared versus dedicated computer/home/browser boundaries without automatic provisioning or copying; verify profile cloning does not transfer cookies and existing computer ownership tests still pass.
- [ ] 4.8 Document capability inheritance, privileged code limits and credential/computer disclosures; verify examples distinguish configuration isolation from OS or browser isolation.

## 5. Pi extension-host integration

- [ ] 5.1 Add only the vetted compatible Pi dependency version and a separate profiled `AgentRuntime` adapter; verify package lock/provenance checks, TypeScript build and legacy direct-Agent conformance remain passing.
- [ ] 5.2 Implement explicit resource loading with implicit extensions, skills, stock filesystem tools, local auth, independent compaction and filesystem session persistence disabled; verify host tests cannot discover resources from server home or a repository.
- [ ] 5.3 Project canonical product history into an in-memory SDK session and map events, usage, cancellation and errors back to existing contracts; verify chat streaming, steering, approval resume and context parity fixtures.
- [ ] 5.4 Load only pinned approved artifacts with per-bot settings/state, namespaced tool registration and collision rejection; verify 2 bots never reuse mutable extension instances or state.
- [ ] 5.5 Route supported extension tools, hooks, commands, nested calls, messages and model/MCP requests through current product policy and effect controls; verify no supported API bypasses a deny, approval or communication gate.
- [ ] 5.6 Implement compatibility preflight and headless fallbacks with explicit rejection of unsupported required APIs; verify tool/hook examples succeed and terminal/session-owning examples fail actionably.
- [ ] 5.7 Bound startup, asynchronous hooks, outputs/state and cleanup, with fail-closed safety-hook errors and visible optional-observer failures; verify timeout, cancellation, duplicate cleanup and missing pinned-artifact recovery.
- [ ] 5.8 Add operator-only artifact approval/update/withdrawal and owner-only assignment validation without arbitrary bot-driven fetch/install; verify pinned updates, revoked artifacts and installation/assignment authority separation.
- [ ] 5.9 Document the versioned extension API matrix, artifact provenance procedure and privileged-host boundary; verify examples run through both API and worker hosts and do not require a hidden terminal interaction.

## 6. Shared management API and safe portability

- [ ] 6.1 Add authenticated effective-profile, revision, validate, diff/apply and compatible resource-assignment procedures using existing RPC conventions; verify expected-revision, idempotency and cross-owner request tests.
- [ ] 6.2 Add scoped learning policy/review/candidate, memory status and goal control contracts, separating operator artifact management from bot ownership; verify direct API calls cannot elevate those authorities.
- [ ] 6.3 Add capability negotiation and legacy response projections for strict enum/message decoders; verify old clients retain chat, approvals, stream cursors and partial-setting update behavior.
- [ ] 6.4 Integrate versioned profile bundles with existing portability previews and resource rebinding; verify unsupported versions, malicious executable content, cross-owner references and unresolved credentials apply nothing unsafe.
- [ ] 6.5 Add privacy-safe activity/query views for revisions, validation, provider status and pending work; verify unavailable providers do not prevent local profile inspection.
- [ ] 6.6 Document API examples, authentication, conflicts and import defaults in existing API/portability docs; verify examples exercise real test API handlers rather than direct database writes.

## 7. Governed local memory and continuous-chat freshness

- [ ] 7.1 Add source/evidence typing and metadata for new derived memories while labeling unknown legacy provenance honestly; verify user assertions, observed outcomes and inferences remain distinguishable.
- [ ] 7.2 Enforce private/shared/history-generation authorization before provider access and before returning cached results; verify cross-bot and revoked shared-scope recall cannot leak content.
- [ ] 7.3 Refresh bounded memory at run and model-turn boundaries and enable authorized pre-compaction recall; verify an approved correction is usable in the same visible chat without reset.
- [ ] 7.4 Implement corrections, supersession, local suppression and anti-relearning checks with expected revisions; verify stale facts and unchanged forgotten evidence cannot reappear as approved knowledge.
- [ ] 7.5 Integrate chat clear, archival and bot/account deletion with review/task cancellation and generation invalidation while preserving intentionally saved durable notes; verify clear-versus-forget behavior explicitly.
- [ ] 7.6 Add a durable provider synchronization/deletion outbox with source rechecks and late-retain cleanup; verify stale retries, scope revocation and deletion races never restore product retrieval.
- [ ] 7.7 Extend provider capability/status and memory export schemas without making an external backend required; verify no-provider, read-only provider and partial-export states are truthful.
- [ ] 7.8 Document memory types, sharing, retention and correction/forget distinctions; verify the documented controls correspond to API and lifecycle tests.

## 8. Learning, reflection and reversible curation

- [ ] 8.1 Implement off/proposals-only/automatic-private policy with eligible source windows, finite limits and a dedicated review model role; verify existing bots cause no new review calls by default.
- [ ] 8.2 Add durable bounded outcome-review jobs using current scheduling/claims and stable bot/source/generation/policy identities; verify repeated triggers, restart, cancellation and generation changes reconcile one review.
- [ ] 8.3 Generate structured memory, instructional-skill and disabled-goal candidates with evidence, outcome status, scope and target revision; verify failed/unproven work cannot be labeled validated from assistant text alone.
- [ ] 8.4 Implement deterministic candidate validation for schema, sources, scope, revisions, secrets, artifact types and authority; verify injected source instructions cannot modify the promotion rules.
- [ ] 8.5 Implement versioned semantic qualification with a provider-neutral rubric and reviewed positive/negative calibration cases for free-form quality; verify judge errors or unqualified results cannot auto-promote.
- [ ] 8.6 Implement candidate decisions, conflicts, rejection dedupe and idempotent promotion with revision/audit/provider-sync writes; verify duplicate approvals apply once and stale targets require regeneration.
- [ ] 8.7 Enforce the automatic-private boundary and mandatory owner confirmation for persona/instructions, shared data, executable artifacts, permissions, connections and enabled goals; verify every prohibited candidate type stays pending or rejected.
- [ ] 8.8 Add instructional-skill usage/outcome tracking, immutable-source protection, private forks and reversible stale archival; verify pinned or paused-goal/routine-referenced skills are preserved and restore retains provenance.
- [ ] 8.9 Expose bounded reflection/request/status tools through the same durable workflow without timers or recursive reviews; verify duplicate requests share one execution and review-only output cannot retrigger itself.
- [ ] 8.10 Document learning modes, evidence standards, promotion/undo and finite cost controls; verify disabling learning prevents queued and already-produced candidates from later automatic promotion.

## 9. Bounded goals, wake checks and communication

- [ ] 9.1 Implement explicit goal definitions and disabled model/import proposals with owner-reviewed enablement and narrowed tool scope; verify enabled goals cannot gain capabilities absent from the bot profile.
- [ ] 9.2 Map schedule/watch/event/idle triggers onto existing routine infrastructure without changing legacy routines; verify initial baseline, unchanged fingerprints, authorized event scope and repeated webhook behavior.
- [ ] 9.3 Add deterministic due/expiry/freshness/cooldown/dedup checks before any bounded wake-model call; verify no-change and disabled goals create no task-model call or ordinary notification.
- [ ] 9.4 Implement atomic per-bot/per-goal budget reservations and call/token/time/concurrency/message limits with usage reconciliation; verify concurrent occurrences cannot overspend reservations and unknown-price monetary limits fail honestly.
- [ ] 9.5 Start goal work as normal Rakazo runs with goal snapshot, source trust and current action approvals; verify read-only goals cannot send/write and pending human input releases active compute resources.
- [ ] 9.6 Implement one proactive communication gate for final and intermediate user-message paths with timezone, DST, quiet hours, cooldown and channel settings; verify direct message tools cannot bypass limits.
- [ ] 9.7 Persist occurrence/result/delivery identities and reconcile result commit versus notification; verify crash points and repeated dispatch produce one logical result without rerunning the completed task.
- [ ] 9.8 Implement inspect, pause/resume, cancel, retire, expiry and bounded catch-up, including archival, clear-generation and access-loss checks; verify offline cancellation and pause-during-approval prevent later actions.
- [ ] 9.9 Document enabled-goal authority, uncertain external effects, quiet-hour delivery and budget behavior; verify the owner can identify why each test wake and notification occurred.

## 10. Optional Hindsight adapter and retention conformance

- [ ] 10.1 Inspect the intended Hindsight OSS deployment/API version, authentication, namespace layout, license and documented capabilities without provisioning another service; verify exact evidence and absence of a mandatory hosted vendor dependency.
- [ ] 10.2 Implement optional scoped recall/retain/reflect through the existing semantic-memory contract, preferring published HTTP APIs unless a vetted SDK is necessary; verify private/shared namespace mapping and current authorization filters.
- [ ] 10.3 Integrate approved-artifact ingestion, stable metadata, deduplicated synchronization and bounded reflect-to-proposal behavior; verify raw full transcripts and unreviewed model inferences are not automatically retained.
- [ ] 10.4 Verify real OSS deletion/export and asynchronous retain semantics using non-sensitive fixtures; exercise late ingestion, scoped forgetting and provider outage, and keep writes disabled if suppression/reconciliation cannot be proved.
- [ ] 10.5 Add explicit scoped backfill preview, egress consent, budget/checkpoints and cancellation only for requested historical retention; verify no background backfill starts merely by connecting the provider.
- [ ] 10.6 Document setup, privacy/egress, supported operations, failure status and local-only fallback; verify settings report provider capabilities and incomplete erasure/export honestly.

## 11. Optional constrained route selection

- [ ] 11.1 Add a routing role/provider configuration distinct from approval using current decisions and model-connection abstractions; verify enabling routing does not change action review or require Jev specifically.
- [ ] 11.2 Define versioned finite route labels mapped by code to allowed model/effort/execution tuples; verify disabled specialist modes, unavailable models and unsafe endpoints are excluded before classification.
- [ ] 11.3 Insert bounded selection before final model resolution with persisted-route and explicit-choice precedence; verify one committed classifier decision per eligible run and no reclassification on ordinary resume.
- [ ] 11.4 Validate selected and fallback routes for protocol, account/credential, media, tools, effort, context and budget; verify timeout, unknown label, revoked credential and no-valid-fallback cases fail safely.
- [ ] 11.5 Represent background/specialist selection as execution metadata without changing the user trigger or transcript admission; verify routed user requests and results remain visible in the canonical chat.
- [ ] 11.6 Record redacted route policy/label/executed tuple/fallback/actual usage and evaluate labeled task fixtures; verify unknown cost stays unknown and approval/routing usage is separate.
- [ ] 11.7 Document routing opt-in, precedence, failure behavior and Jev configuration through existing connection settings; verify no classifier output can supply endpoints, secrets or permissions.

## 12. Thin CLI, web/Electron and native mobile controls

- [ ] 12.1 Implement a thin CLI with current API authentication, inspect/validate/diff/apply, profile import/export and JSON/redacted human output; verify unauthenticated/stale-revision failures and no direct production database or runtime access.
- [ ] 12.2 Add CLI candidate decisions, memory status/correction and goal inspect/control operations; verify cross-client state parity, idempotent retries and nonzero exit status for rejected actions.
- [ ] 12.3 Build web/Electron persona, profile/resource assignment, compatibility and effective-configuration controls with current UI components and translations; verify conflict, loading, empty, error and revoked-resource states.
- [ ] 12.4 Build matching native mobile configuration and resource controls through shared contracts; verify touch/accessibility behavior and the same server-side validation as web, without package upload or local configuration editing.
- [ ] 12.5 Add evidence/diff/promotion/restore and memory privacy/status controls on web and mobile; verify shared-scope confirmation, conflicted proposal handling, forget status and immutable source display.
- [ ] 12.6 Add goal/budget/quiet-hour/wake-history controls and stop actions on web/mobile plus compatible standard chat summaries; verify mobile pause reaches active workers and older clients can still read ordinary conversation.
- [ ] 12.7 Integrate portable profile previews, capability negotiation and safe unresolved-reference handling in clients; verify old-client partial edits and unsupported extension renderer fallbacks.
- [ ] 12.8 Run the existing UI build and applicable UI audit workflow, inspect desktop and mobile screenshots including review/error states, and record audit numbers and remaining gaps; verify keyboard/focus/screen-reader paths and no console/runtime errors.
- [ ] 12.9 Document CLI commands and cross-platform management using tested examples in existing user docs; verify every feature in the profile management spec has an API and an accessible supported client control.

## 13. Optional durable specialist continuation

- [ ] 13.1 Vet the exact Pi Durable candidate or equivalent adapter API/license and prototype ownership/checkpoint integration without a second active scheduler or deployment; verify a written conformance result against existing Rakazo leases/fences and effect replay.
- [ ] 13.2 Add private durable task records and approved dispatch with parent/profile/generation, narrowed authority, recursion and budget limits; verify default short-lived specialists remain unchanged and no second public chat appears.
- [ ] 13.3 Bind continuation resume and supported tools to current ownership, approvals, effect journal and computer concurrency; verify stale fence, duplicate claim, revoked resource and occupied-computer cases.
- [ ] 13.4 Persist cancellation, checkpoints and terminal results with stable completion/delivery identities; verify offline cancel, restart after result commit, child propagation and stale-generation suppression.
- [ ] 13.5 Inject failures before/after checkpoint, approval, external dispatch, effect commit and result delivery across both stores; verify uncertain effects are not blindly resent and only one logical result reaches the bot.
- [ ] 13.6 Document optional store ownership, retention/backup and adapter limits with activation disabled until all conformance gates pass; verify missing/failed adapters leave core profiles and short-lived specialists usable without falsely reporting durable mode complete.

## 14. Integrated release readiness and undo

- [ ] 14.1 Run the integrated policy/runtime/testkit suite across legacy and profiled paths with an independent database fixture; verify chat streaming, approval/cancel, source generations, nested tools and optional-off behavior remain correct.
- [ ] 14.2 Exercise cross-owner/privacy and adversarial-source scenarios across extensions, memory, learning, goals, routing and specialists; verify no supported path expands authority or leaks a private scope.
- [ ] 14.3 Rehearse expanded-schema old/new worker overlap, dispatch capability filtering, feature kill switches and binary rollback with queued/active/approval-wait work; verify restricted profiles never execute on an unenforcing legacy worker.
- [ ] 14.4 Run the full repository release checks once after focused suites, plus real configured adapter conformance and reviewed semantic calibration; verify exact pass/fail evidence and explicitly list unverified optional modes.
- [ ] 14.5 Produce the release/undo record linked from the board with feature defaults, migration state, artifacts, compatibility evidence, UI audit results and remaining gaps; verify no production action is implied by a planning or local build result.
- [ ] 14.6 Prepare release through the existing owner-facing service/data path and report Ready to go live if deployment authorization is absent; if authorized, verify the exact URL, active service/build revision, requested actions and exercised undo without creating a parallel deployment.

## Workflow follow-up

- Keep the board linked to these canonical artifacts. Planning completion does not mark implementation tasks complete.
- After implementation and owner review, use the official OpenSpec archive workflow to synchronize capability specs and archive the change.
- Verify the archived result and retain the release evidence and unresolved gaps on the board; do not create a second handover or task-tracking file.
