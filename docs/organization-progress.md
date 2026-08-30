# Organization Progress — Autonomous AI Company OS

## Git recovery — 2026-08-30

- Snapshot backup: `/Users/ufuksamet/Desktop/rakazo-main-snapshot-backup-20260830`.
- Git worktree: `/Users/ufuksamet/Desktop/rakazo-git` from upstream `d9f37db` on `feat/autonomous-organization-runtime`; it was subsequently merged with upstream `main` at `9fc328a`.
- Recovered implementation commit: `06f76e7 feat: add autonomous organization runtime`.
- Organization source, migrations, tests, and documentation were transferred through a file inventory; generated output and machine-local artifacts were excluded.
- `FLAGSHIP POSTGRESQL INTEGRATION TEST — IMPLEMENTED / CI VERIFICATION PENDING`.
- Local PostgreSQL verification remains unavailable because Docker is absent and the local macOS 27 + Node 26 Prisma schema engine fails before migration execution. The supported Linux/Testcontainers CI harness remains authoritative.
- Writable fork remote: `https://github.com/ufuksamet0/rakazo.git`; branch commits including `f1ad447 fix: wire organization API and fence reviews` are pushed.
- Pull request: [#394](https://github.com/elie222/rakazo/pull/394). The upstream GitHub Actions run is not yet created because GitHub requires a repository maintainer to approve workflows from this external fork. This is an external authorization blocker, not a migration or flagship-test result.

> **Takeover correction — 2026-08-30:** the earlier phase labels describe
> scaffolding, not completed autonomous-company behavior. The authoritative
> status is now recorded in [codex-takeover-audit.md](./codex-takeover-audit.md).
> In particular, the execution bridge and all autonomous management loops are
> unimplemented stubs; mobile does not implement the organization product.

## Current phase

**Phase 5H — first autonomous vertical slice IN PROGRESS.** The recovered Git
worktree and PR now preserve provenance; PostgreSQL CI verification is awaiting
the upstream maintainer's workflow approval.

### 2026-08-30 Phase 2 implementation status

| Area | Status | Evidence |
| --- | --- | --- |
| Durable WorkItem ↔ Run association | IMPLEMENTED — UNVERIFIED DB migration | `WorkItemExecution` schema/migration records run, attempt, timestamps, result, and failure. |
| Execution bridge | IMPLEMENTED — unit/type-verified | `createOrganizationExecutionBridge` creates normal Rakazo Task/Run records and enqueues `run.continue`; it never calls a model provider. |
| Executor completion sync | IMPLEMENTED — type-verified | RunExecutor has an optional post-finalization hook that persists organization execution result. |
| Employee assigned-work dispatch | IMPLEMENTED — type-verified | Fenced wakeup selects/claims a ready assigned item and enqueues `workitem.dispatch`. |
| Retry policy | IMPLEMENTED — type-verified | Maximum of three attempts by default, `in_progress → failed → ready`, exponential delayed wake. |
| Autonomous review decision | IMPLEMENTED — type-verified | `workitem.review` creates a normal Rakazo Task/Run for the reviewer. Final output must satisfy `ReviewDecisionSchema`; malformed output returns the review to pending without changing WorkItem completion. |
| Manager decision contract | IMPLEMENTED — VERIFIED | `ManagerDecisionSchema` bounds decisions to five validated `create_work_item`, `assign_work_item`, or `escalate` proposals. |
| Manager runtime | IMPLEMENTED — unit/type-verified | `manager.evaluate` now creates a durable `ManagerEvaluation`, normal Rakazo Task/Run, and `run.continue` job. Run finalization parses a schema-validated decision, pre-validates it, applies it once behind a durable status fence, and wakes assignees. |
| Manager evaluation durability/retry | IMPLEMENTED — unit/type-verified; DB migration unverified | `ManagerEvaluation` records manager, project, run, planning key, attempt, result/error, and lifecycle timestamps. A planning key has unique sequential attempts; malformed/run failures retry with bounded exponential backoff, while permanent validation failures do not retry. Terminal manager failure escalates once. |
| Work terminal escalation | IMPLEMENTED — type-verified | Exhausted WorkItem attempts create one open escalation, wake the reporting manager when present, and schedule project evaluation. |
| Project progress evaluator | IMPLEMENTED — unit/type-verified | Deterministic required-WorkItem aggregation computes progress and transitions active projects to completed/blocked when persistent state warrants it. |
| Goal progress evaluator | IMPLEMENTED — unit/type-verified | Deterministic project aggregation can achieve an active goal only when all non-cancelled projects are completed. |
| Human Attention backend | IMPLEMENTED — type-verified | Read-model service aggregates unroutable escalations, organization approval waits, and unowned failures without duplicating workflow state. |
| Rakazo approval continuation | IMPLEMENTED — unit/type-verified | Executor hooks mark a WorkItem `waiting_approval` only after Rakazo pauses its existing Run for approval, and return it to `in_progress` when that same Run resumes. No new WorkItemExecution is created. Deterministic approval-path coverage remains to be added. |
| Flagship Manager → Developer → QA PostgreSQL orchestration | IMPLEMENTED — CI VERIFICATION PENDING | `packages/testkit/src/organization-autonomy.postgres.test.ts` seeds only the company fixture and `manager.evaluate`, then drains real AppHandles job handlers through `DeterministicOrganizationJobQueue`. It asserts provenance, two developer executions, two reviews, feedback propagation, project/goal completion, no escalations, and an idle queue. It is selected by `pnpm test:integration` and is gated by `VERIFY_DATABASE=1`. Local invocation on 2026-08-30 stopped before migrations/tests because Testcontainers could not find a container runtime; Linux GitHub Actions remains the required execution environment. |
| Postgres migration / E2E verification | BLOCKED BY ENVIRONMENT | Docker daemon is unavailable. |

Relevant offline verification: `organization-execution-bridge.test.ts` confirms the bridge creates a normal Task, Run, durable execution association, and `run.continue` job; it also confirms a successful unreviewed execution settles the WorkItem once. This is not a substitute for a Postgres or real-runtime scenario.

### 2026-08-30 verified repairs

- Generic `workItems.update` no longer changes lifecycle status; callers must
  use the transition operation so state changes produce validated events.
- Reviewed WorkItems cannot complete through a generic transition.
- Review creation now requires a reviewer and a valid `→ waiting_review`
  transition, rejects duplicate pending reviews, and review completion is
  single-use/state-validated.
- Cross-workspace idempotency-key collisions now fail closed.

### Next work

1. Add the complete deterministic Manager → Developer → QA feedback-loop harness and retry/escalation scenarios.
2. Add manager bounded retry/escalation policy, approval pause/resume propagation, and integration-level queue/event assertions.
3. Execute migrations against PostgreSQL when an environment is available; inspect all migration SQL meanwhile.

### PostgreSQL verification when available

Run `pnpm --filter @rakazo/db exec prisma migrate deploy`, then run the organization integration suite against an empty database and an upgraded database. The Phase 4B/5 migration order is `20260830110000_add_manager_evaluations`, `20260830120000_add_work_item_required`, and `20260830130000_manager_evaluation_attempt_keys`; the latter intentionally replaces the original planning-key uniqueness constraint with `(planningKey, attempt)` so existing installations can receive bounded retries safely.

`DeterministicOrganizationJobQueue` now exists as a test-only transport and executes the real registered handlers with a bounded trace/drain. It is ready for the flagship test fixture but does not replace a Prisma-backed integration database. A local PGlite socket server was also tried on 2026-08-30; Prisma's schema engine failed during `migrate deploy` with an undefined engine error, so it is not a valid substitute for PostgreSQL verification in this repository.

### 2026-08-30 real PostgreSQL provisioning attempt

Homebrew `postgresql@16` (PostgreSQL 16.15, arm64) was installed and used only through an isolated temporary cluster bound to `127.0.0.1:55433`; `psql` and `createdb` succeeded for `rakazo_org_test`. `prisma migrate deploy` and `prisma migrate status` both failed before creating `_prisma_migrations`, reporting only `Schema engine error: undefined`. Debug output confirms Prisma selected the correct local URL. This is a local Prisma schema-engine compatibility failure on macOS 27 / Node 26, not a Docker or database-connectivity failure. The temporary server was stopped; its disposable data directory remains at `/tmp/rakazo-postgres-phase5d-20260830` for diagnosis and has not been used by production.

The repository's existing real-PostgreSQL CI route is `.github/workflows/ci.yml` → `test-integration` → `pnpm test:integration`, which starts PostgreSQL 16 through `@testcontainers/postgresql` and runs `prisma migrate deploy`. The flagship Prisma integration test should be added to that canonical harness once its fixture is implemented; it will verify the actual migration chain on supported Linux Prisma engines.

## 2026-08-29 — Phase 0 ✅
- Repository audit (AGENTS.md, package.json, pnpm-workspace.yaml, apps/*, packages/*, Prisma schema, router, executor, background jobs, worker, realtime)
- `docs/organization-engine.md` — architecture map + org layer design

## 2026-08-29 — Phase 1 ✅
- Prisma domain model: `Department`, `EmployeeProfile`, `EmployeeRuntimeState`, `CompanyGoal`, `Project`, `WorkItem`, `WorkItemReview`, `Escalation`, `StandardOperatingProcedure`, `CompanyEvent`
- Extended `Organization` with org relations, `Bot.employeeProfile`
- Migration `20260829024754_add_organization_layer` created via `prisma migrate dev --create-only`, validated, client generated
- 10 new indexes, FKs with `onDelete: Cascade/SetNull`, JSON authority storage, cuid ids

## 2026-08-29 — Phase 2 ✅
- Modular contracts `packages/contracts/src/organization/` — department, employee, goal, project, work-item, review, sop, event, escalation, policy
- Zod schemas + types, Create/Update inputs, filters
- Exported via `packages/contracts/src/index.ts` (re-export) + subpath `organization/*`
- Extended `appContract` in `packages/contracts/src/rpc.ts` with `organization` subtree (overview, departments, employees, goals, projects, workItems, reviews, sops, escalations, events)

## 2026-08-29 — Phase 3-4 ✅
- New package `packages/organization` (workspace package, pure domain)
  - `work/transitions.ts` — WorkItem FSM (backlog→ready→assigned→planning→in_progress→waiting_review→reviewing→completed + blocked/waiting_approval/failed/cancelled)
  - `goals/transitions.ts`, `projects/transitions.ts`
  - `work/duplicate-detection.ts` — normalized title + idempotencyKey builder
  - `departments/hierarchy.ts` — cycle detection
  - `employees/authority.ts` — DEFAULT/MANAGER/EXECUTIVE policies
  - `sop/validation.ts`
  - `jobs/defs.ts` — OrgJobName/Payloads helpers
  - `events/company-events.ts` — emitCompanyEvent
  - `engine/company-health.ts` — evaluateCompanyHealth (stalled/blocked projects, idle/overloaded, failures, review bottlenecks, goals without projects)
  - `execution/bridge.ts` — stub + helpers (buildWorkItemInstruction)
  - 20 tests in `organization.test.ts` all passing

## 2026-08-29 — Phase 5-7 ✅
- Extended `packages/adapter-kit` job payloads+schemas: `organization.tick`, `employee.wakeup/evaluate`, `manager/executive.evaluate`, `goal/project.evaluate`, `workitem.dispatch/review`, `sop.trigger`, `company.health.evaluate`
- Added job helpers `employeeWakeupJob`, `organizationTickJob`, `orgJobKey`
- Updated `packages/adapter-kit/src/background-jobs.test.ts`, `packages/adapters/src/wakeup.test.ts`, `wakeup.postgres.test.ts` to include new handlers (fixes `pnpm check`)
- `packages/adapters/src/background-job-handlers.ts` — added idempotent stubs for all org jobs (lease update for employee.wakeup)

## 2026-08-29 — Phase 8-19 ✅ (partial vertical slice)
- `apps/api/src/organization.ts` — full service layer (all handlers reuse `IsolationError`, `ORPCError`, `assert*Transition`, duplicate detection, cycle check, SOP validation, authority checks)
  - Departments CRUD + hierarchy validation + events
  - Employees CRUD + runtimeState upsert + wake logic
  - Goals/Projects CRUD + FSM validation
  - WorkItems CRUD + deterministic duplicate prevention + transition/assign/delegate + events
  - Reviews (create pending → transition work to waiting_review, complete → approved→completed or changes_requested→in_progress)
  - SOPs CRUD + validation + version bump
  - Escalations (auto-target manager chain, runtime blocked marking)
  - Overview (health + counts + recent events), CompanyEvents list, wakeEmployee
- API wiring: `apps/api/src/router.ts` — imports `Org` helpers, adds `organization` router block under `authed.*`, reuses existing auth/actor pattern
- Added `@rakazo/organization` dep to `apps/api/package.json`

## 2026-08-29 — Phase 20-26 ✅ (Company UI)
- `apps/web/src/pages/Company.tsx` — overview cards, departments/employees/goals/projects lists, 6-column work board (backlog/ready/assigned/in_progress/waiting_review/completed), recent activity
- Wired into `apps/web/src/App.tsx` as lazy route `/app/company`
- Uses `rpc.organization.*` via existing `ContractRouterClient`, typed with `@rakazo/contracts`
- `pnpm --filter @rakazo/web check` clean

## Verification 2026-08-29
- `pnpm --filter @rakazo/db generate` ✅
- `pnpm --filter @rakazo/organization check` ✅ (20 tests)
- `pnpm --filter @rakazo/contracts check` ✅
- `pnpm check` (turbo) ✅ 21/21 packages (after fixing adapter tests)
- `pnpm test` ✅ 203 passed, 1 pre-existing failure in `desktop-sandbox-write-containment` (unrelated to org), 15 skipped
- `pnpm --filter @rakazo/api check` ✅
- `pnpm --filter @rakazo/web check` ✅
- No secrets in tracked diff (uses `IsolationError`, fake placeholders, no `.env` committed)

## Known limitations / remaining TODOs (to be tackled in follow-up PR)
- Execution bridge currently stub: WorkItem → Task/Run creation not yet wired through `OrganizationExecutionBridge.createRun` (requires executor+thread context); work dispatch via API exists but autonomous wake→work discovery loop not yet scheduled via worker tick
- Work discovery engine (responsibilities/goals/backlog evaluation) — designed in `docs/organization-engine.md`, not yet implemented as `employee/heartbeat.ts` + `work-discovery.ts` runtime
- Manager/executive loops (prioritize/assign/decompose) — stubs in `background-job-handlers`, need full `management/manager-loop.ts`
- Employee lease fencing token logic currently simple `updateMany`; needs `SELECT FOR UPDATE` + `leaseFence` CAS for distributed safety
- Resource governance (max concurrent runs, budgets) — `policy/resource-limits.ts` not yet implemented
- Office visualization (`/app/company/office`) — deferred after work board
- Realtime `company:*` via `PostgresRealtimeFanout` not yet emitting (events persisted, fanout wiring pending)
- Full integration tests for concurrency (two wakeup jobs), idempotent duplicate WorkItem, cross-workspace isolation — design ready, tests not yet written (unit tests cover deterministic duplicate + FSM)
- No hosted vendor required — LLMs/sandboxes remain optional behind `adapter-kit` interfaces as per spec

## Next entry point
- Complete `packages/organization/src/execution/bridge.ts` → wire `createWorkItem` → create Rakazo `Task`+`Run`+`JobPublisher.enqueue(runContinueJob)` and link via `idempotencyKey`/`clientNonce`
- Implement `employee/heartbeat.ts` + `work-discovery.ts` + `management/manager-loop.ts` with bounded limits (maxWorkItemsPerEvaluation, decomposition depth)
- Add `apps/web/src/pages/CompanyOffice.tsx` with live status polling
- Add Postgres integration tests for org jobs + lease
- Note: repository is not a git repo in this workspace (zip download); diff review required before pushing to https://github.com/elie222/rakazo fork
