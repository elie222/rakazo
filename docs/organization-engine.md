# Organization Engine — Architecture Map
> Phase 0 — Repository audit and architecture design for Rakazo → Autonomous AI Company OS

## 1. Current Rakazo Architecture (as of 2026-08-29)

### 1.1 Monorepo layout
```
apps/
  api      — Hono + oRPC router, Graphile Worker publisher, Realtime fanout
  worker   — Graphile Worker host (runs jobs)
  web      — React 19 + Vite, Tailwind, oRPC client
  desktop  — Electron shell hosting web UI
  mobile   — Expo app
packages/
  contracts — zod schemas + oRPC contract (`appContract`)
  core      — pure domain logic, no IO (transitions, cron, etc.)
  db        — Prisma Client + helpers (repos, scope, events, computers)
  adapter-kit — provider-neutral interfaces (AgentRuntime, SandboxProvider, JobPublisher, MemoryStore)
  adapters  — concrete adapters (Pi runtime, docker/e2b/daytona/box, memory, MCP, connectors)
  memory, auth, ui-web, ui-tokens, testkit
```

### 1.2 Ownership boundary
- `Organization` (Prisma) **is** the company/tenant boundary. `Member.organizationId == workspaceId`.
- `Actor { userId, workspaceId, email }` is derived via `requireMembership()` (db/scope.ts) and threaded through every oRPC handler as `context.actor`.
- `Bot.workspaceId + Bot.userId` enforces per-user workspace isolation. Cross-workspace access throws `IsolationError`.

### 1.3 Execution flow
```
Client (web/desktop) ── oRPC ──► apps/api/router.ts ──► createRun (Task+Run)
                                        │
                                        ▼
                              JobPublisher (Graphile / InMemory)
                                        │
                                        ▼
                              Worker: executor.continueRun(runId)
                                        │
                                        ▼
                              Executor (packages/adapters/src/executor.ts)
                                ├─ resolve model credential (UserModelCredential)
                                ├─ load bot context (instructions, memory, skills)
                                ├─ buildAgentRequest (tools, history, prompt)
                                └─► PiAgentRuntime (or ScriptedAgentRuntime for tests)
                                        │
                                        ▼
                              Tools: SandboxProvider, ConnectorRegistry, Memory, MCP, Skills
                                        │
                                        ▼
                              Result → Thread Events → ExternalEffect idempotency → PostgresRealtimeFanout → client subscribe
```

### 1.4 Key primitives
- **Bot** — AI execution identity (has Thread, Computer, MemoryDocument, BrowserProfile). `Bot.id` used as foreign key.
- **Task** — user intent (prompt + status) bound to Bot+Thread.
- **Run** — execution of a Task (lease: `leaseOwner`, `leaseFence`, `leaseExpiresAt`; statuses: queued→leased→running→completed/failed; idempotency via `clientNonce`).
- **Routine** — cron/webhook scheduler, creates Run on wakeup via `routine.wakeup` job.
- **Graphile Worker** — jobs table `graphile_worker._private_jobs`; produced via `GraphileJobPublisher` (or `InMemoryJobQueue` for tests). Reconciliation via `createJobReconciler`.
- **Computer** — sandbox lifecycle (team vs dedicated, execution leases, control leases). Workspace persisted via `AgentHomeStore` + checkpoint.
- **Memory** — `MemoryDocument` (MD files) + pluggable `MemoryStore` (Supermemory etc).
- **MCP / Connectors** — registry per workspace; routed into Pi tools at build time.
- **Approvals** — `ActionApprovalRule` + `ActionAutoReviewPreference` gating in executor (`planActionGate`, `resolveActionApprovalDetail`). ExternalEffect approval flow blocks tools.
- **Realtime** — `PostgresRealtimeFanout` (LISTEN/NOTIFY) or InMemory fanout.

### 1.5 Routing & validation
- Contract defined in `packages/contracts/src/rpc.ts` (`appContract` at `/rpc`).
- Handler: `apps/api/src/router.ts` — `implement(appContract).$context<{ actor, signal }>` via `@orpc/server`.
- Every mutating handler re-checks `actor.workspaceId / actor.userId` via `requireMembership` + scoped queries.

### 1.6 Current gaps for Company OS
- No department hierarchy, employee authority/autonomy, goal→project→work decomposition.
- No autonomous wake/sleep loop; routines wake but reasoning engine decides work.
- No durable WorkItem abstraction separable from Task/Run.

## 2. Organization Layer Design

### 2.1 Principle: Organization ≠ Execution
```
Organization layer (new)        Execution layer (existing)
─────────────────────           ──────────────────────────
WHAT should happen              HOW it executes

Department, EmployeeProfile,    Bot, Thread, Task, Run, Routine,
Goal, Project, WorkItem,       Computer, Sandbox, Pi, MCP,
Review, Escalation, SOP,       Memory, Composio/MCP tools,
CompanyEvent, CompanyHealth     Approvals, Realtime
```

- `Bot` remains the execution identity. `EmployeeProfile.botId UNIQUE` is the organizational identity extension (1:1, nullable until bot is onboarded as employee).
- Shared behavior lives in new packages; only small integration seams touch existing code.

### 2.2 Domain model (Prisma extensions)

All new models carry `workspaceId` FK → `Organization.id` with `onDelete: Cascade` and tenant isolation indexes.

| Entity | Key fields | Notes |
|--------|-----------|-------|
| `Department` | `workspaceId`, `name`, `parentDepartmentId`, `managerBotId` | tree, cycle prevention in service |
| `EmployeeProfile` | `botId UNIQUE`, `workspaceId`, `departmentId`, `reportsToBotId`, `role`, `mission`, `responsibilities`, `authority` (JSON), `autonomyLevel`, `workMode`, `status` | authority as JSON policy, validated |
| `EmployeeRuntimeState` | `botId UNIQUE`, `status`, `currentWorkItemId`, `lastActiveAt`, `nextWakeAt`, `failureCount`, `leaseOwner`, `leaseFence`, `leaseExpiresAt` | distributed lease for evaluation |
| `CompanyGoal` | `workspaceId`, `title`, `priority`, `status`, `ownerBotId`, `targetAt`, `metrics` | FSM: draft→active→achieved/archived |
| `Project` | `workspaceId`, `goalId`, `name`, `status`, `ownerBotId` | belongs to goal or standalone |
| `WorkItem` | `workspaceId`, `projectId`, `parentWorkItemId`, `title`, `priority`, `status`, `assignedToBotId`, `reviewerBotId`, `dueAt`, `idempotencyKey UNIQUE` | core work engine, FSM validated |
| `WorkItemReview` | `workItemId`, `reviewerBotId`, `status`, `feedback` | persistent review |
| `Escalation` | `workspaceId`, `sourceBotId`, `targetBotId`, `workItemId`, `severity`, `status` | durable escalation chain |
| `SOP` | `workspaceId`, `name`, `trigger`, `definition` (JSON), `version`, `active` | validated, versioned |
| `CompanyEvent` | `workspaceId`, `type`, `actorBotId`, `workItemId`/project/goal refs, `payload` | append-only log, realtime emitted |

Existing `Event` table remains thread-scoped realtime events. `CompanyEvent` is organization-scoped.

### 2.3 Package layout

```
packages/organization/         — pure org domain (no adapters)
  src/
    engine/   organization-engine.ts, company-health.ts
    departments/ department-service.ts, hierarchy.ts
    employees/ employee-service.ts, employee-context.ts, runtime.ts, autonomy-policy.ts, work-discovery.ts, heartbeat.ts
    goals/ goal-service.ts
    projects/ project-service.ts
    work/ work-item-service.ts, transitions.ts, delegation.ts, review.ts, dependencies.ts, duplicate-detection.ts
    management/ manager-loop.ts, executive-loop.ts, escalation.ts
    sop/ sop-engine.ts, sop-runner.ts
    policy/ policy-engine.ts, authority.ts
    events/ company-events.ts
    execution/ organization-execution-bridge.ts
    jobs/ job-defs.ts   (BackgroundJob extension helpers)

packages/contracts/src/organization/  — zod schemas + types for all org entities (modular)
```

### 2.4 State machines

- **WorkItem**: `backlog → ready → assigned → planning → in_progress → waiting_review → reviewing → completed` plus `blocked`, `waiting_approval`, `failed`, `cancelled`. Every transition must be allowed by `WorkItemTransitions` map; violated transitions throw.
- **Goal**: `draft → active → achieved / archived`; `active ↔ paused`; `active → failed`.
- **Project**: `planned → active → blocked → completed`; `active ↔ paused`; `active → cancelled`.
- **EmployeeRuntime**: `offline/idle/evaluating/planning/working/blocked/waiting_review/reviewing/waiting_approval/sleeping/error`.

### 2.5 Autonomy loop (event-driven, not poll loop)

```
employee.wakeup job (or assignment, event, SOP trigger, heartbeat)
  → try acquire lease (SELECT FOR UPDATE / lease fence)
  → buildEmployeeContext (filtered: dept, goals, projects, queue)
  → if assignedWork exists → execute via bridge (highest priority)
  → else → workDiscovery: inspect goals/projects/backlog/responsibilities/events
  → if duplicate check fails → merge / dedupe
  → if meaningful work found → claim/create WorkItem → execute
  → else → compute nextWakeAt (min-wake interval, heartbeat) → sleep
```

- Lease prevents duplicate evaluation (fencing token + expiry). Idempotency keys prevent duplicate WorkItems/Runs.
- `workMode: supervised | standard | autonomous` + `authority` gates creation/assignment/delegation/external actions.
- Manager loop: inspect dept backlog/unassigned/blocked/overdue/reviewQueue/escalations; may prioritize/assign/decompose.

### 2.6 Execution bridge

```
WorkItem.execute → OrganizationExecutionBridge
  → validate assignee + authority
  → buildEmployeeContext (trusted org context + untrusted external content separated)
  → create Rakazo Task+Run (reuse existing Task/Run primitives)
  → link Run.clientNonce ↔ WorkItem.idempotencyKey
  → start executor.continueRun path
  → on completion → persist outcome, transition WorkItem, emit CompanyEvent, schedule next evaluate
```

Never calls vendor SDK directly; always goes through existing Task/Run → Executor → Pi.

### 2.7 Jobs (extend existing Graphile)

Add to `adapter-kit/background-jobs.ts`:

- `organization.tick` — periodic company health
- `employee.wakeup` / `employee.evaluate`
- `manager.evaluate` / `executive.evaluate`
- `goal.evaluate` / `project.evaluate`
- `workitem.dispatch` / `workitem.review`
- `sop.trigger`
- `company.health.evaluate`

All jobs idempotent (replaceKey = dedup) and serialized via Graphile.

### 2.8 API & Realtime

- Modular oRPC routers under `apps/api/src/routers/organization/*` composed into root router (`organization.ts`, `departments.ts`, `employees.ts`, `goals.ts`, `projects.ts`, `work-items.ts`).
- Every handler re-derives `workspaceId` server-side; rejects cross-workspace IDs.
- Realtime: reuse `PostgresRealtimeFanout`; emit `company:*` topic events; frontend subscribes via existing `threads.subscribe` pattern or new `companyEvents.subscribe`.

### 2.9 Upstream friendliness
- No fork of RunExecutor; bridge composes it.
- No duplicate MCP/memory/computer/sandbox code.
- Workspace stays as tenant; do not add second tenant table.
- EmployeeProfile is extension entity; Bot schema unchanged except nullable index.

### 2.10 Runaway & security

- Limits: max concurrent employees, min wake interval, max WorkItems per evaluate, max decomposition depth/children, retry backoff, duplicate detection (deterministic title+project+sourceEvent key).
- Trust boundary: external content (web, GitHub, emails) never overrides authority/policy/hierarchy.
- LLM proposes intent; app code validates transitions & authority before state mutation.

## 3. Implementation order (vertical slice first)

1. Prisma schema + migration
2. contracts/organization
3. packages/organization core (transitions, services, duplicate detection)
4. jobs + bridge (minimal executor wiring)
5. API routers
6. web Company pages (Overview/Office/Goles/Projects/Work)

End-to-end acceptance slice: Engineering Manager decomposes Goal→Project→WorkItems, Dev executes via bridge, QA reviews, all visible in Company UI without manual orchestration.

## 4. Open decisions
- Use `cuid()` for all org IDs (matches Bot/Thread).
- Authority stored as JSON with zod validation in contracts (typed `AuthorityPolicy`).
- SOP initial engine is JSON trigger→steps with role resolution; no BPMN.
