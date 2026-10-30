# Spec Delta

## Purpose

Let bot owners assign compatible Pi extensions from a deployment-approved catalog while making executable-code trust, runtime compatibility and lifecycle limits explicit.

## ADDED Requirements

### Requirement: Installation and assignment are separate authorities
Only an authenticated deployment operator SHALL approve executable extension installation or updates. A bot owner SHALL assign only approved, immutable versions available to their scope. The catalog SHALL record source provenance, digest, license, compatibility and required capabilities. Bot output, imports and model tool calls SHALL NOT install executable code.

#### Scenario: A bot requests an arbitrary package
- **WHEN** a bot or tenant submits a package URL not approved by the operator
- **THEN** the system refuses installation and does not fetch or execute its code

#### Scenario: Update an installed extension
- **WHEN** the operator approves a newer extension artifact
- **THEN** existing bot assignments remain on their pinned version until explicitly updated

### Requirement: Compatibility is declared and validated
The system SHALL publish a versioned extension compatibility matrix covering tools, hooks, commands, model selection, MCP, state, UI and process ownership. It SHALL validate assignments before activation and report unsupported APIs explicitly. Terminal-only UI, independent session ownership and unsupported process-wide behavior SHALL NOT be silently accepted.

#### Scenario: Assign a supported extension
- **WHEN** an extension uses only supported APIs for the selected host version
- **THEN** the preview identifies its capabilities and permits activation after policy validation

#### Scenario: Assign an incompatible extension
- **WHEN** an extension requires an unsupported session or terminal API
- **THEN** activation fails with a compatibility reason instead of presenting the extension as working

### Requirement: Per-bot settings and state
The system SHALL isolate extension settings and durable state by bot and extension version. It SHALL give each active extension instance a run-owned lifecycle and SHALL NOT reuse mutable runtime objects across bots. Shared state SHALL require an explicit authorized service rather than an accidental global variable or shared home.

#### Scenario: The same extension serves 2 bots
- **WHEN** both bots use the same approved artifact with different settings
- **THEN** each receives its own settings and state without observing the other's runtime object

#### Scenario: Resume after a crash
- **WHEN** an extension-enabled run resumes in another worker
- **THEN** the system restores permitted durable state and does not depend on an in-memory timer or object from the failed worker

### Requirement: Extension actions use product policy
Supported extension tools, commands, nested calls, model changes, messages and MCP requests SHALL use the bot's effective policy and existing action approval and effect controls. An extension SHALL NOT gain extra authority through an alternate supported API. Capability metadata SHALL NOT replace authorization.

#### Scenario: Extension invokes a disabled nested tool
- **WHEN** an extension calls a tool disabled for the bot
- **THEN** the call is denied before the underlying action executes

#### Scenario: Extension requests another model or MCP server
- **WHEN** an extension requests a model or server outside the bot's allowed configuration
- **THEN** the request is refused or becomes an owner-reviewed configuration proposal, not an immediate capability grant

### Requirement: Trust disclosure and deployment scope
The system SHALL identify installed extensions as operator-trusted server code, not sandboxed tenant code. Owners SHALL see whether an assignment requires privileged host access. The product SHALL NOT claim credential or filesystem isolation from same-process trusted code. Untrusted executable extensions SHALL remain unsupported in this release.

#### Scenario: Enable a privileged extension
- **WHEN** an owner previews an assignment with host-level behavior
- **THEN** the preview discloses that trust boundary and distinguishes it from the bot's computer sandbox

### Requirement: Deterministic lifecycle and failures
The system SHALL bound startup and hook execution, preserve cancellation, and perform idempotent cleanup. A failed required extension SHALL stop the run before its dependent actions. Optional failures SHALL be visible and SHALL NOT silently remove a safety gate. Recovery SHALL preserve the pinned artifact or fail explicitly if it is unavailable.

#### Scenario: A safety hook errors
- **WHEN** an extension hook that can block an action fails or times out
- **THEN** the affected action does not execute and the failure is recorded

#### Scenario: Cancel a run with extension resources
- **WHEN** the owner cancels the run
- **THEN** owned work receives cancellation, cleanup can run repeatedly, and no extension-owned proactive timer continues independently

#### Scenario: Pinned artifact is unavailable on recovery
- **WHEN** a replacement worker cannot load the recorded extension digest
- **THEN** the run reports a recoverable configuration failure instead of loading a different version

### Requirement: Headless and cross-platform behavior
Supported extension interactions SHALL use shared, serializable product actions and standard result rendering. Custom terminal components SHALL be unsupported unless they have an explicit headless fallback. Unattended work SHALL never synthesize approval or wait for an invisible terminal prompt.

#### Scenario: A tool requests confirmation on mobile
- **WHEN** a supported extension action needs owner approval
- **THEN** it uses the same persisted approval flow available to other product actions

#### Scenario: A terminal-only renderer has no fallback
- **WHEN** an extension requires that renderer to complete an interaction
- **THEN** the compatibility check rejects the assignment rather than leaving an unusable control
