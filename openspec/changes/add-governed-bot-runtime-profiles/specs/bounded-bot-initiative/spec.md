# Spec Delta

## Purpose

Allow bots to pursue owner-enabled goals and offer useful proactive help through bounded, recoverable work that respects existing permissions and notification choices.

## ADDED Requirements

### Requirement: Goals require explicit enablement
Each goal SHALL define its objective, owner, bot, scope, trigger, permitted tools, budget, expiry and completion or stop conditions. Model-created and imported goals SHALL start disabled. Enabling or expanding a goal SHALL require authenticated owner confirmation and SHALL NOT grant capabilities absent from the bot policy.

#### Scenario: Reflection creates a desire
- **WHEN** reflection proposes an ongoing research goal
- **THEN** it appears as a disabled goal with its expected cost, scope and requested capabilities for review

#### Scenario: Owner enables an unavailable capability
- **WHEN** a goal requires a tool not assigned to the bot
- **THEN** enablement reports the missing assignment rather than granting the tool automatically

### Requirement: Existing routines and watches remain usable
Initiative SHALL build on existing schedules, deterministic change detection and run history. Existing routines SHALL keep their current behavior unless the owner opts them into new policy. New goals SHALL support scheduled checks, authorized events and bounded idle review without requiring a second scheduler or chat.

#### Scenario: Watch establishes its first baseline
- **WHEN** an enabled change-based goal has no prior observation
- **THEN** its first check records a baseline and does not invent a change event

#### Scenario: Existing routine is not migrated to a goal
- **WHEN** profile support is rolled out
- **THEN** the routine retains its configured trigger, model and notifications

### Requirement: Wake decisions are bounded and attributable
Before model-driven initiative, the system SHALL check enablement, expiry, quiet-hour policy, source freshness, duplicate events, cooldown and remaining budget. It SHALL avoid model calls when deterministic checks already require no work. A permitted model wake decision SHALL use bounded evidence and SHALL NOT redefine its own goal.

#### Scenario: No watched change occurred
- **WHEN** the observation fingerprint is unchanged
- **THEN** no task model call or user notification is produced unless the owner explicitly requested unchanged reports

#### Scenario: An external event contains instructions
- **WHEN** a webhook or watched document requests broader actions
- **THEN** the text remains untrusted input and cannot change goal scope or owner authorization

### Requirement: Resource and spending limits are explicit
New initiative SHALL have per-bot and per-goal limits for frequency, calls, tokens, elapsed work, retries, concurrent work and proactive messages. Spending caps SHALL be hard only when pricing is known; otherwise the system SHALL enforce call/token ceilings and disclose unknown cost. Waiting for human input SHALL release active execution resources.

#### Scenario: A goal exhausts its allowance
- **WHEN** the next step would exceed a hard applicable limit
- **THEN** the system pauses the goal, records the reason and requires an owner change or the next valid budget window

#### Scenario: Model price is unavailable
- **WHEN** a goal has a monetary cap but its model has no trustworthy price
- **THEN** the system does not promise monetary enforcement and requires a bounded supported configuration before execution

### Requirement: Proactive effects remain approval-controlled
Initiative SHALL obey current tool denies, source-trust rules, destination checks and action approvals. Owner enablement SHALL authorize only the defined goal, not every later proposed action. Consequential actions outside explicit grants SHALL wait for owner approval; unattended work SHALL never approve itself or weaken approval settings.

#### Scenario: Research suggests sending a message
- **WHEN** a read-only research goal decides an external message would help
- **THEN** it prepares the proposal but cannot send without the required owner approval

#### Scenario: Approval mode cannot ask
- **WHEN** an unattended action requires explicit approval but the applicable mode cannot ask
- **THEN** the action is denied or the goal pauses instead of bypassing the requirement

### Requirement: Proactive communication has one policy gate
Every user-facing initiative message and notification SHALL pass a common bot/goal communication policy, including intermediate tool messages. It SHALL respect quiet hours, timezone, cooldown, deduplication and channel preferences. Silent or no-change runs SHALL remain inspectable without producing repetitive chat messages.

#### Scenario: A goal runs during quiet hours
- **WHEN** its policy allows silent work but not notifications
- **THEN** work can proceed within budget and its ordinary update waits until the allowed delivery window

#### Scenario: A tool tries to bypass notification limits
- **WHEN** an initiative run calls a direct user-message tool after its message allowance is exhausted
- **THEN** the same communication policy blocks or defers the message

### Requirement: Goals recover without duplicate work or delivery
Goal occurrences and source events SHALL have durable identities. Multiple workers or repeated webhooks SHALL NOT create duplicate work for the same occurrence. Recovery SHALL reconcile committed work and pending delivery. Uncertain external effects SHALL require reconciliation rather than blind replay; the system SHALL NOT claim universal exactly-once external execution.

#### Scenario: Crash after result commit
- **WHEN** a worker stops after saving a result but before notifying the owner
- **THEN** recovery delivers the saved result once logically and does not rerun the task merely to recreate it

#### Scenario: Crash after an unconfirmed external request
- **WHEN** the provider outcome cannot be established
- **THEN** the goal records uncertainty and does not automatically repeat the consequential request

### Requirement: Pause, cancellation and expiry stop authority
Owners SHALL inspect, pause, resume, cancel and retire goals. Pausing or expiry SHALL stop new occurrences and prevent later actions after the next policy check. Chat clearing, bot archival, scope loss and deletion SHALL invalidate affected queued work. Resume SHALL not create an unbounded catch-up storm.

#### Scenario: Pause while a run waits for approval
- **WHEN** the owner pauses the goal before answering
- **THEN** later approval cannot restart actions until the goal is explicitly resumed and revalidated

#### Scenario: Recover after prolonged downtime
- **WHEN** many timer occurrences were missed
- **THEN** the system applies the configured bounded catch-up policy and records what it coalesced or skipped
