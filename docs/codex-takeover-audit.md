# Codex takeover audit

**Audit started:** 2026-08-30
**Evidence standard:** implementation and executed checks, not prior progress notes.

## Scope and repository state

- `AGENTS.md`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, workspace configuration, package manifests, Prisma schema/migrations, organization sources, API router/service, background jobs, web Company page, Expo mobile app, and native iOS project were inspected.
- This directory is a source snapshot, not a Git checkout: it has no `.git` ancestor. Consequently branch, status, history, staged diff, and commit provenance cannot be verified here. No commit is made from this snapshot.
- The workspace contains web, API, worker, Electron, Expo mobile, and a separate native SwiftUI iOS project. `apps/ios` is excluded from `pnpm-workspace.yaml`.

## Validation performed

| Check | Result | Notes |
| --- | --- | --- |
| `pnpm test packages/organization/src/organization.test.ts` | Passed | 20 pure-domain tests only. |
| `pnpm check` | Passed | 21 Turbo tasks; most tasks were cached. This is type checking, not runtime verification. |
| Database migration from zero / forward migration | Not run | Requires an isolated Postgres database; no configured safe database was found during this pass. |
| Full unit, integration, E2E, web/desktop/mobile builds | Not yet run | Required before a production claim. |

## Verified implementation inventory

| Area | Classification | Evidence / finding |
| --- | --- | --- |
| Organization schema | Implemented but architecturally incomplete | Models exist in `packages/db/prisma/schema.prisma`: Department, EmployeeProfile, runtime state, Goal, Project, WorkItem, Review, Escalation, SOP, event. Cross-workspace relations use independent IDs/FKs, so the database cannot guarantee tenant matching for every relation. |
| Bot vs EmployeeProfile separation | Implemented | `EmployeeProfile` is a 1:1 extension of Bot; organizational fields are not placed directly on Bot. |
| Department nesting | Implemented but incomplete | API checks parent workspace and cycle on update; database has no cycle prevention and manager/reporting consistency is not enforced. |
| Goal / Project lifecycle | Implemented but incomplete | Pure FSMs and API status checks exist. No outcome/progress evaluator proves completion is meaningful. |
| WorkItem lifecycle | Implemented but broken before takeover repair | Pure FSM allowed paths; generic update also changed status and review endpoints updated status outside transition invariants. The generic mutation path is now rejected and review paths validate lifecycle state. |
| Work claiming / concurrency | Not implemented | No durable CAS claim or fenced lease for WorkItems. |
| Idempotent work creation | Implemented but incomplete | Deterministic key and duplicate check exist, but no source-event persistence and no transactional duplicate strategy across related work/reviews/events. |
| Employee wakeup | Implemented but incomplete | A durable, conditional, fenced lease now prevents concurrent duplicate wakeup evaluation. The handler deliberately sleeps after acquiring because no evaluator exists yet. |
| Employee autonomy / idle sleep | Not implemented | No event-driven evaluation, context builder, bounded work discovery, or explicit sleep policy. |
| Manager / executive loops | Mock / placeholder | Registered job types are no-op handlers. |
| Execution bridge | Documented but not implemented | `packages/organization/src/execution/bridge.ts` only builds text. It does not create a Task/Run or invoke `RunExecutor`. |
| Rakazo execution reuse | Not implemented for organization | Existing RunExecutor/runtime/MCP/memory/sandbox stack remains intact, but organization WorkItems never enter it. No direct provider SDK call was found in the organization package. |
| Review system | Implemented but incomplete | Persistence/UI/API exist. There is no reviewer wakeup or authorization based on actual reviewer identity. |
| Approval continuation | Not implemented | WorkItem has `waiting_approval`, but no link to a Rakazo approval/run continuation. |
| Delegation | Implemented but incomplete | Persistent child WorkItems are created. Authority falls back to hard-coded role labels, lacks depth/child limits, and does not wake the assignee. |
| Escalation | Implemented but incomplete | Persistent entity and manager-target fallback exist; no deduplication, manager wake, lifecycle policy, or authorization enforcement. |
| SOPs | Implemented but incomplete | CRUD and basic schema validation exist. Trigger handler is no-op and there is no durable trigger deduplication. |
| Company health | UI-only / incomplete | A query-based report exists but emits no events, has simplistic thresholds, and does not cause management action. |
| Resource governance | Not implemented | No run, budget, token, wake, delegation, or decomposition limits are enforced. |
| Jobs / idempotency | Implemented but broken | Job payload schemas exist in adapter-kit. All organization handlers except a timestamp update are no-ops; `replaceKey` is not a distributed execution lease. |
| Realtime company updates | Not implemented | Company events are persisted but no company realtime topic/fanout/subscription is wired. |
| Web Company experience | Implemented but incomplete | One `/app/company` page fetches real organization API data and renders a basic board. No Office, attention inbox, reports, employee detail integration, realtime, or validated interaction depth was verified. |
| Electron | Existing Rakazo surface only | Electron hosts web, so it inherits the limited Company page; no separate company verification performed. |
| Expo mobile | Existing Rakazo mobile, no company layer | No organization/company API usage or company control center was found. |
| Native iOS | Implemented but incomplete / separate | A SwiftUI app provides sign-in, inbox, thread SSE, computer observation/control. It contains no Company, Goal, Project, WorkItem, approval, escalation, or organization integration; Routine/Integrations/Voice are explicit placeholders. It is not part of the pnpm build/check. |

## Migration audit

The organization migration is `20260829024754_add_organization_layer` and follows current dated migrations. It creates the organization tables and indexes, but has notable integrity gaps:

- `EmployeeProfile.departmentId`, `reportsToBotId`, Department manager, Project goal, WorkItem project/parent, Review work item, and Escalation work item are not composite workspace-aware foreign keys. API checks cover some paths, but direct database writes and future code can create cross-workspace associations.
- `WorkItem.idempotencyKey` is globally unique rather than scoped to a workspace. The service now returns a conflict for a cross-workspace collision, but schema design should be repaired in a forward migration.
- No database constraint prevents department/reporting/work-item cycles or validates status/authority values stored as strings/JSON.
- Migration application from empty and existing databases remains unverified.

## P0/P1 repair plan

1. **P0 completed in this pass:** remove generic WorkItem status mutation; require validated transition endpoint; prevent direct completion of reviewed WorkItems; require a valid state and reviewer for review requests; prevent repeat review completion; guard cross-workspace idempotency collisions.
2. **P1 partial in this pass:** introduce a conditional, durable employee evaluation lease with a monotonic fence and exact-owner release. Unit tests cover failed duplicate claim and fence-scoped release. An end-to-end Postgres concurrency test remains required.
3. **P1 next:** implement a transactional WorkItem claim; persist execution linkage; dispatch through the existing Task/Run/RunExecutor path; wire bounded evaluation/failure handling.
4. **P1 next:** replace no-op manager/executive/review/SOP/health jobs with idempotent handlers or remove unsupported scheduling until behavior exists.
5. **P1 next:** introduce forward migration constraints/indexes for tenant-safe relationships and test clean/upgrade migrations.

## Security assessment (focused)

- API methods consistently scope primary reads by `actor.workspaceId`, which is a positive base boundary.
- Tenant integrity is still defense-in-depth incomplete because most relationship FKs do not constrain matching workspace IDs.
- Organizational authority is not an authorization boundary for human API callers; role-name fallbacks in delegation conflict with the requirement not to hard-code roles.
- External-content trust boundaries and execution-context separation are not implemented because the employee execution/context system does not exist.
- No direct model-provider invocation was found in organization code. This avoids a provider-bypass issue but does not satisfy execution integration.

## iOS audit

The native project is SwiftUI with Keychain token storage, RPC calls, a thread SSE client, and a WebKit computer screen. It has endpoint tests only and is not included in workspace validation. It is not the requested iOS company control center: no organizational state/contracts, approval routing, notifications, company realtime, Company/Office/Goals/Projects/Work/Activity views, employee details, escalation handling, or management actions were found. Its placeholder feature views should not be presented as product completion.

## Current conclusion

The takeover baseline is an **organization CRUD vertical slice and contract/schema scaffold**, not a persistent autonomous AI company OS. The next engineering work must concentrate on durable execution, lease/idempotency, lifecycle invariants, and tenant-safe persistence before UI expansion.
