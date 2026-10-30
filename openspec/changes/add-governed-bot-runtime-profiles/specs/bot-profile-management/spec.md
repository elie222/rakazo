# Spec Delta

## Purpose

Make per-bot configuration, learning and initiative manageable across existing clients and a thin CLI through one authenticated, versioned API.

## ADDED Requirements

### Requirement: One shared management contract
The system SHALL expose profile inspection, expected-revision updates, validation, assignments, learning review, goal control and status through the existing authenticated API and shared contracts. Web, mobile and CLI SHALL use the same authorization, validation and conflict rules. No client SHALL edit the database, worker environment or service files directly.

#### Scenario: Change the profile from the CLI
- **WHEN** an authenticated owner applies a valid expected-revision update
- **THEN** web and mobile observe the same saved configuration and audit record

#### Scenario: A request contains a secret field
- **WHEN** a management request tries to store raw credentials in profile or extension settings
- **THEN** the API rejects that field and directs the owner to an existing secure connection workflow

### Requirement: Cross-platform controls cover the full profile
Current web/Electron and native mobile clients SHALL let authorized owners inspect and manage persona, compatible extensions, skills, tool/MCP access, model/routing policy, memory/learning settings and goals. Installed resources SHALL display unavailable and unsupported states. Code installation SHALL remain an operator workflow, not a mobile package upload feature.

#### Scenario: Enable a compatible extension from mobile
- **WHEN** the owner selects an operator-approved version and confirms its required capabilities
- **THEN** the assignment uses the same validation and profile revision behavior as web

#### Scenario: Required extension is unsupported
- **WHEN** the selected artifact cannot run on the current host
- **THEN** the client displays the compatibility reason and does not report successful activation

### Requirement: Learning review exposes evidence and effects
Review controls SHALL show the proposal type, target scope, source evidence, proposed diff, validation status and possible authority effects. Owners SHALL approve, reject or correct candidates and inspect applied revisions. Unsafe or conflicted candidates SHALL NOT have a misleading enabled approval action.

#### Scenario: Review a shared-memory proposal
- **WHEN** the owner opens the candidate on any supported client
- **THEN** the UI identifies who can see the target scope and requires explicit confirmation before sharing

#### Scenario: Open a conflicted proposal
- **WHEN** the target was edited after the proposal
- **THEN** the client shows the conflict and requires regeneration or a new expected-revision edit

### Requirement: Initiative is visible and controllable
The product SHALL distinguish a goal proposal, an enabled goal, its occurrences, pending approvals, delivery and paused/error states. Owners SHALL see applicable limits and quiet hours, inspect why a wake occurred and stop work from supported clients. Disabling initiative SHALL NOT silently delete goals or change unrelated existing routines.

#### Scenario: Inspect a proactive message
- **WHEN** the owner opens its details
- **THEN** the product identifies the goal, occurrence, trigger and reason for the notification

#### Scenario: Stop initiative from a phone
- **WHEN** the owner pauses a goal
- **THEN** the API persists the pause immediately and later worker actions obey it

### Requirement: Thin CLI supports safe automation
The CLI SHALL use the public shared API with existing authentication, redacted output, structured JSON, expected revisions and nonzero failure status. It SHALL support inspect, validate, diff/apply, import/export, candidate decisions and goal controls. It SHALL NOT open the production database, start a second bot runtime or silently install extensions.

#### Scenario: Apply a stale profile file
- **WHEN** its expected revision no longer matches
- **THEN** the CLI returns a conflict and does not overwrite remote changes

#### Scenario: Run an unauthenticated command
- **WHEN** the command requires an account session
- **THEN** it fails without printing tokens or falling back to server-local administrative rights

### Requirement: Import and export reuse authorized portability
Profile import/export SHALL use a schema version, a preview and current resource rebinding. It SHALL integrate with existing account portability rather than create an untracked parallel data format. Executable content, credential values, personal histories and cross-owner resource identifiers SHALL NOT become usable capabilities merely by import.

#### Scenario: Import a bundle from another space
- **WHEN** extension, skill or MCP references are not available to the importing owner
- **THEN** preview marks them unresolved and imports no executable authority or secret values

#### Scenario: Restore a bot with saved goals
- **WHEN** a portable bundle includes goal definitions
- **THEN** they remain disabled until the owner reviews the new environment and enables them

### Requirement: Old clients remain usable
The API SHALL preserve current chat, streaming, cancellation, approval and existing setting behavior for compatible older clients. New controls SHALL use capability negotiation or additive versioned responses. Old enum schemas and message decoders SHALL receive compatible representations rather than unknown values that break existing clients.

#### Scenario: An older mobile client sees a learning result
- **WHEN** it cannot render the new review control
- **THEN** ordinary chat remains readable and a standard message or supported review link explains where to manage it

#### Scenario: An older client edits unrelated settings
- **WHEN** it submits only fields it knows
- **THEN** new profile fields remain unchanged rather than being cleared by missing keys

### Requirement: Management is accessible and diagnosable
Controls SHALL support keyboard and screen-reader use, mobile-sized touch targets and clear pending, empty, conflict, error and disabled states. UI validation SHALL show actionable reasons without leaking secrets or another tenant's metadata. Read-only inspection SHALL work when optional providers are unavailable.

#### Scenario: A provider is offline while settings are open
- **WHEN** the owner inspects the saved profile
- **THEN** local configuration remains readable and remote status is labeled unavailable rather than shown as an empty profile

#### Scenario: Navigate learning review without a pointer
- **WHEN** an owner uses keyboard or assistive navigation
- **THEN** the evidence, diff and decision controls have a coherent focus order and accessible names
