# Spec Delta

## Purpose

Deliver the new profile capabilities as additive Rakazo changes while preserving current user-visible chat, ownership, recovery, approvals and safe operational rollback.

## ADDED Requirements

### Requirement: Rakazo stays the product and system of record
The system SHALL retain existing accounts, authenticated API, canonical thread per bot, Postgres run ownership, persisted chat events and cursor-resumable streaming. No new feature SHALL move the user's conversation into a second runtime or make an optional memory/continuation store authoritative for user history.

#### Scenario: Reconnect to a profile-enabled run
- **WHEN** a client reconnects with its existing stream cursor
- **THEN** it follows the same logical run and canonical chat without opening a separate continuation conversation

#### Scenario: Optional backend is unavailable
- **WHEN** Hindsight or a continuation store is offline
- **THEN** authoritative transcript access and unaffected ordinary chat remain available

### Requirement: One run and effect ownership model
All new execution modes SHALL use existing leases, fences, cancellation, approval resumption and effect reconciliation. Background jobs MAY create or request runs but SHALL NOT become a parallel unchecked tool executor. Repeated dispatch SHALL be safe and current computer ownership SHALL remain effective.

#### Scenario: Two workers receive one goal occurrence
- **WHEN** both attempt to start its run
- **THEN** durable ownership admits one current executor and the other reconciles rather than duplicating actions

#### Scenario: A stale worker reaches an effect
- **WHEN** its execution fence no longer matches
- **THEN** the system rejects the new effect before external dispatch

### Requirement: Events distinguish activity from conversation
Learning, routing and internal review telemetry SHALL be inspectable without filling the user's chat with internal transcripts. User-requested work and approved proactive results SHALL keep their admission and delivery semantics. New status events SHALL be versioned or represented compatibly for existing clients.

#### Scenario: Several silent reviews complete
- **WHEN** none needs owner review or delivers a meaningful update
- **THEN** activity records are available without several new assistant messages

#### Scenario: User work runs asynchronously
- **WHEN** routing changes its execution mode
- **THEN** the user's request and final result remain visible in the existing chat

### Requirement: Expand-first migration preserves existing behavior
Database and contract changes SHALL be additive during rollout. Existing bots SHALL retain their instructions, model selection, skill-library behavior, MCP permissions, computers, routines and memory-sharing choices. New learning, initiative, routing, semantic providers and durable specialists SHALL remain off until explicitly enabled.

#### Scenario: Old and new workers overlap
- **WHEN** deployment runs both supported versions during rollout after the capability-aware baseline is established
- **THEN** unsupported workers cannot claim profile-required work, and legacy work remains processable

#### Scenario: A pre-guard binary is still active
- **WHEN** a worker cannot enforce the required-capability admission predicate
- **THEN** restricted profile work remains disabled or held until that worker is drained and the guarded baseline is verified

#### Scenario: Legacy profile backfill repeats
- **WHEN** migration or lazy backfill runs more than once
- **THEN** it creates no duplicate profiles or assignments and does not reset later owner edits

### Requirement: Rollback is defined before activation
Each feature SHALL have a kill switch and documented handling for active, queued and pending-approval work. Binary rollback SHALL preserve new data and exclude unsupported work from old executors. A profile requiring unsupported enforcement SHALL fail closed rather than run with wider legacy access. Destructive schema reversal SHALL NOT be the routine undo path.

#### Scenario: Disable learning during rollout
- **WHEN** the deployment disables the learning feature
- **THEN** new reviews stop, unfinished promotions cannot proceed, and approved historical revisions remain inspectable

#### Scenario: Roll back the application binary
- **WHEN** the old version cannot enforce a profile's required capabilities
- **THEN** affected work is drained or held before rollback, not executed with reduced protection

### Requirement: Observability is scoped and truthful
The system SHALL record profile/resource versions, policy decisions, job identities, provider status, routing and learning outcomes, budget usage and delivery state in authorized activity views. Logs and exports SHALL redact secrets and minimize personal text. Unknown costs, uncertain effects and unconfirmed deletion SHALL remain unknown rather than reported as success.

#### Scenario: Inspect uncertain external work
- **WHEN** a tool request may have reached a provider before a crash
- **THEN** the activity view distinguishes uncertainty from failure or confirmed success

#### Scenario: Review a model call without metering
- **WHEN** no trustworthy usage is available
- **THEN** telemetry reports unknown cost rather than attaching unrelated process or turn totals

### Requirement: Release gates prove exact behavior
Release SHALL require deterministic policy and lifecycle tests, old-client fixtures, migration/rollback tests, cross-owner isolation, provider capability tests and fault injection around effects and delivery. Extension compatibility SHALL have contract tests. Any semantic evaluator SHALL use reviewed calibration cases. UI delivery SHALL include build checks and inspected desktop and mobile screenshots.

#### Scenario: A fake provider passes unit tests
- **WHEN** production adapter parity or owner-facing authentication remains unverified
- **THEN** release evidence explicitly reports that gap and does not claim the integration is live or compatible

#### Scenario: Verify the active deployment
- **WHEN** an authorized release claims the feature works through the owner-facing app
- **THEN** verification records the URL, active service and build revision plus the tested action through that entry point
