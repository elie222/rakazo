# Spec Delta

## Purpose

Optionally let private specialist tasks continue beyond a parent turn without introducing a second user-facing chat, competing executor or independent permission system.

## ADDED Requirements

### Requirement: Durable continuation is an optional execution mode
Existing short-lived specialists SHALL remain the default. Durable specialist mode SHALL require deployment support and explicit profile policy. A durable continuation adapter SHALL be admitted only after its ownership, replay and effect conformance checks pass; Pi Durable SHALL be a candidate implementation rather than an assumed drop-in replacement.

#### Scenario: No durable continuation is configured
- **WHEN** a bot invokes an ordinary specialist
- **THEN** existing scoped short-lived behavior remains available without a second database or continuation dependency

#### Scenario: Enable an unverified continuation adapter
- **WHEN** its ownership or effect conformance checks have not passed
- **THEN** the deployment cannot activate that adapter for production work

### Requirement: Specialist tasks have explicit durable identity
Each durable task SHALL record its initiating run, bot, owner, profile revision, history generation, delegated capability subset, input references, budgets and terminal result state. The task SHALL remain private internal work, not a second public bot thread or independent account.

#### Scenario: Continue after the parent turn ends
- **WHEN** approved specialist work outlives its parent response
- **THEN** it retains its durable identity and can deliver a result to the same bot without creating another visible conversation

#### Scenario: Inspect task ownership
- **WHEN** an authorized owner inspects a specialist result
- **THEN** the product identifies its parent request and scoped authority without exposing another owner's task data

### Requirement: Rakazo retains execution and effect authority
The adapter SHALL run only under Rakazo's durable ownership and cancellation rules. It SHALL NOT hold an independent active tool executor after Rakazo's lease is lost. All supported side effects SHALL use the existing approval and effect journal. The continuation store SHALL NOT become a competing canonical transcript, credential store or scheduler.

#### Scenario: Parent execution loses its fence
- **WHEN** another worker takes ownership of a task
- **THEN** the former worker cannot issue a new protected effect and the replacement reconciles the existing effect journal

#### Scenario: Continue an uncertain tool request
- **WHEN** the effect journal reports an unknown external outcome
- **THEN** replay does not resend that effect without reconciliation or renewed owner direction

### Requirement: Authority is inherited and can be revoked
A specialist SHALL use the intersection of current bot policy, the recorded parent policy and the task's delegated subset. It SHALL have no broader memory, workspace, extension or credential access. Child recursion and parallelism SHALL remain within configured limits. Current revocation SHALL override recorded access.

#### Scenario: Specialist attempts to spawn unrestricted work
- **WHEN** a child requests tools or recursion depth beyond its delegated limits
- **THEN** the request is denied before new work starts

#### Scenario: Parent bot loses a connection
- **WHEN** a continuing specialist next uses that connection
- **THEN** the live revocation check denies it despite the earlier snapshot

### Requirement: Results reconcile once into the canonical chat
Task completion, result acceptance and user-visible delivery SHALL have stable durable identities. Repeated completion notices SHALL produce one logical result. Results from stale history generations SHALL NOT reintroduce cleared chat content. Task text SHALL be treated as subordinate evidence, not a new owner instruction.

#### Scenario: Crash between completion and delivery
- **WHEN** the result was committed but the owner has not received it
- **THEN** recovery delivers the committed result without repeating the specialist task

#### Scenario: Parent chat was cleared
- **WHEN** a specialist completes against the previous generation
- **THEN** it cannot inject that content into the cleared chat or feed it into learning

### Requirement: Cancellation and budgets survive restart
Owners SHALL be able to inspect and cancel continuing tasks. Cancellation, expiry and budget exhaustion SHALL persist across worker restarts and propagate to child tasks. Waiting for approval SHALL release active compute resources. Tasks SHALL obey existing computer concurrency controls rather than starting an extra browser or computer session silently.

#### Scenario: Cancel while the worker is offline
- **WHEN** an owner cancels a persisted specialist before recovery
- **THEN** recovery does not resume its actions and records cancellation as its terminal state

#### Scenario: Specialist needs an occupied computer
- **WHEN** another run holds the bot's computer
- **THEN** the task follows existing ownership and queue rules without bypassing them
