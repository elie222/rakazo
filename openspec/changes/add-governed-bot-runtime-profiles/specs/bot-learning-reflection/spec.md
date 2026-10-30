# Spec Delta

## Purpose

Let bots improve saved knowledge and reusable workflows through bounded review and reflection, with evidence, explicit authority limits and reversible changes.

## ADDED Requirements

### Requirement: Learning is independently configurable
Each bot SHALL support learning disabled, proposals-only and bounded automatic-private modes. Existing bots SHALL default to disabled for new background learning. Owners SHALL configure review triggers, eligible source types, limits and permitted artifact types. Learning SHALL NOT imply model-weight training or require chat termination.

#### Scenario: Upgrade without learning consent
- **WHEN** an existing bot gains profile support
- **THEN** no new reflection model call, semantic retention or skill mutation begins until learning is enabled

#### Scenario: Enable proposals-only learning
- **WHEN** an eligible completed task is reviewed
- **THEN** the bot can produce candidates but cannot apply them automatically

### Requirement: Outcome review uses bounded evidence
Review SHALL use a defined source window of authorized messages, results and recorded outcomes. It SHALL produce structured candidates with rationale, source references, target scope and expected revision. Unsupported claims SHALL remain unverified proposals. Failed, cancelled and partial work SHALL retain their actual status.

#### Scenario: A claimed success lacks an observed result
- **WHEN** the assistant said a task succeeded but no evidence supports that outcome
- **THEN** review cannot label its workflow as validated solely from that statement

#### Scenario: Review a continuous chat
- **WHEN** the review interval becomes due during a long-lived chat
- **THEN** the job uses a bounded completed source window without resetting the visible conversation

### Requirement: Candidate lifecycle is reviewable
Candidates SHALL have durable pending, approved, rejected, conflicted, applied, superseded and failed outcomes as applicable. Owners SHALL inspect a diff, evidence, target and reason before deciding. Promotion SHALL be idempotent and conditional on current scope, generation and revision. Rejection SHALL prevent identical unchanged candidates from recurring indefinitely.

#### Scenario: Approve from 2 clients
- **WHEN** an owner submits the same candidate approval twice
- **THEN** only one promotion occurs and both clients receive the resulting state

#### Scenario: Candidate target changed
- **WHEN** its target revision differs at approval time
- **THEN** the candidate becomes conflicted and the old diff is not applied blindly

### Requirement: Automatic promotion has a narrow boundary
Automatic promotion SHALL require explicit per-bot policy and be restricted to evidenced private memory and private instructional skills. Persona, operational instructions, shared knowledge, executable code, extensions, credentials, permission changes, enabled routines and goals SHALL always require owner confirmation or a direct authenticated owner edit.

#### Scenario: Automatic mode proposes a new tool grant
- **WHEN** a candidate asks to add an MCP tool or enable an extension
- **THEN** it cannot be promoted automatically regardless of the review model's confidence

#### Scenario: Automatic private memory meets policy
- **WHEN** a candidate has valid evidence, allowed type and scope, current revisions and remaining budget
- **THEN** promotion records the applied revision and the policy that authorized it

### Requirement: Validation separates meaning from structure
The system SHALL validate scope, references, revisions, secret exclusion and artifact structure deterministically. Any automated judgment of a free-form lesson's meaning or quality SHALL use an explicit versioned, provider-neutral rubric calibrated against reviewed examples. Judge errors SHALL leave the candidate unqualified, not approved.

#### Scenario: Quality judge is unavailable
- **WHEN** a candidate requires semantic validation and the judge errors
- **THEN** the candidate remains pending or failed and is not auto-promoted

#### Scenario: Candidate contains an injected permission instruction
- **WHEN** source content tells the reviewer to bypass policy
- **THEN** the source is treated as evidence, not authorization, and deterministic restrictions remain in force

### Requirement: Skills learn without executable self-modification
New learned skills SHALL remain instruction documents with source evidence and usage outcomes. Built-in, plugin-installed and operator-managed skills SHALL NOT be overwritten by automated learning. Editing a shared skill SHALL require owner confirmation; a private proposed fork SHALL retain its origin.

#### Scenario: Improve a plugin skill
- **WHEN** review identifies a problem in an immutable installed skill
- **THEN** it proposes a private fork or owner-reviewed report rather than rewriting the installed artifact

#### Scenario: Learned skill includes a script
- **WHEN** a candidate proposes executable files or package installation
- **THEN** the learning workflow refuses executable promotion and presents it only as a separate owner-reviewed development request

### Requirement: Curation is reversible and dependency-aware
Curation SHALL track use and outcomes, mark stale private learned skills and archive only under enabled policy. It SHALL preserve pinned skills and skills referenced by profiles, routines or goals, including paused ones. Consolidation SHALL default to proposals-only. Automatic curation SHALL NOT permanently delete skills.

#### Scenario: A stale skill is still referenced
- **WHEN** the skill is referenced by a paused routine
- **THEN** automatic archival skips it and records the dependency

#### Scenario: Undo an archive
- **WHEN** an owner restores an archived learned skill
- **THEN** its content and provenance return as a new revision without losing prior usage history

### Requirement: Reflection tools do not own scheduling
Authorized bots SHALL have bounded tools to request review, inspect candidates, propose lessons, propose goals and view learning status. These tools SHALL use the same durable lifecycle as scheduled review. A tool request SHALL NOT create unmanaged timers, recursive self-review or automatically enabled goals.

#### Scenario: A bot requests reflection twice
- **WHEN** both requests cover the same source window and policy revision
- **THEN** they refer to one review execution rather than duplicating model work

#### Scenario: Reflection proposes an initiative
- **WHEN** reflection identifies useful future work
- **THEN** it creates a disabled goal proposal for owner review, not immediate autonomous work

### Requirement: Review work is bounded and cancellable
Learning SHALL have per-bot limits for model usage, candidates, retries, elapsed time and frequency. It SHALL use durable claims and source checkpoints, yield to interactive work that needs the same resource, and stop on disablement, source deletion or revoked access. Reviews of review-only output SHALL NOT recursively trigger themselves.

#### Scenario: Worker restarts after candidate persistence
- **WHEN** a replacement worker resumes the same source window
- **THEN** it reconciles the persisted candidates without creating duplicate promotions

#### Scenario: Owner disables learning
- **WHEN** a review is queued or active
- **THEN** queued work is cancelled and active work cannot promote after the disablement check
