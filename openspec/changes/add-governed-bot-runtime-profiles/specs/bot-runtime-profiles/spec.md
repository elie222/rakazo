# Spec Delta

## Purpose

Give each persistent bot an inspectable, revisioned identity and runtime configuration without creating a separate account, installation or user-facing conversation.

## ADDED Requirements

### Requirement: Independent bot configuration
The system SHALL give each bot its own profile, scoped to its authorized space and owner. The profile SHALL select persona, runtime settings, extension assignments, skills, tool policy, model policy, memory, learning and initiative settings without copying secret values into configuration.

#### Scenario: Two bots use different profiles
- **WHEN** an owner assigns different extensions, skills and memory settings to 2 bots
- **THEN** each bot uses its own configuration and neither inherits the other's assignments

#### Scenario: Unauthorized profile access
- **WHEN** a user reads or changes a profile outside their authorized scope
- **THEN** the system rejects the request without disclosing profile content or resource existence

### Requirement: Identity and instructions remain distinct
The system SHALL keep persona/SOUL separate from operational instructions, learned facts and permissions. An existing bot with no explicit persona SHALL preserve its current instructions. Persona changes SHALL require authenticated owner confirmation, including changes proposed by a bot.

#### Scenario: Upgrade an existing bot
- **WHEN** an existing bot first uses the profile system
- **THEN** its operational instructions remain unchanged and no model invents or silently extracts a new identity

#### Scenario: Reflection proposes a persona edit
- **WHEN** reflection produces a persona change
- **THEN** the system records a reviewable diff and does not apply it until the owner confirms

### Requirement: Explicit revision and conflict behavior
The system SHALL create immutable profile revisions with an actor, reason, timestamp and redacted change summary. Updates SHALL require the expected revision. Restoring an earlier configuration SHALL create a new revision and revalidate current permissions and resource availability.

#### Scenario: Concurrent edits
- **WHEN** 2 clients submit edits against the same revision and one succeeds first
- **THEN** the second receives a conflict and cannot overwrite the first edit silently

#### Scenario: Restore references a revoked extension
- **WHEN** an owner restores a revision containing an extension no longer permitted by the deployment
- **THEN** restoration reports the blocked reference and does not enable the revoked extension

### Requirement: Effective configuration is inspectable
The system SHALL expose the effective configuration with the source of each default or override, unavailable resources and validation errors. Existing model and tool settings SHALL remain consistent across old and new management surfaces; the profile SHALL not become a conflicting second authority for those settings.

#### Scenario: Inspect inherited settings
- **WHEN** the owner inspects a bot without an explicit model override
- **THEN** the view identifies the applicable existing default and distinguishes it from bot-specific settings

#### Scenario: An older client changes a bot setting
- **WHEN** an authorized older client changes a supported model or tool setting
- **THEN** the next effective profile reflects that edit without restoring a stale duplicate value

### Requirement: Runs use stable configuration snapshots
The system SHALL record the effective profile revision and referenced resource versions when a run begins. Ordinary profile edits SHALL affect later runs, not silently rewrite active run behavior. Capability and credential revocations SHALL apply before subsequent protected actions even in active or resumed runs.

#### Scenario: Edit persona during a run
- **WHEN** the owner changes persona while a run is active
- **THEN** that run retains its recorded persona and a later run uses the new revision

#### Scenario: Revoke access during an approval wait
- **WHEN** a tool or credential is revoked before an approved run resumes
- **THEN** the resumed run cannot use the revoked resource even though its snapshot previously allowed it

### Requirement: Safe profile portability
The system SHALL support versioned profile templates, cloning and export/import with a dry-run diff. Portable profiles SHALL exclude credentials, session tokens, private histories, learned memory content and executable artifacts by default. Import SHALL rebind resource references and leave new initiative and executable capabilities disabled until confirmed.

#### Scenario: Clone a bot profile
- **WHEN** an owner clones a profile
- **THEN** the new bot has a separate canonical chat and private memory, with no copied secret values or silently enabled goals

#### Scenario: Import an unknown profile version
- **WHEN** an import declares an unsupported schema version or unresolved capabilities
- **THEN** the preview reports the incompatibility and applies nothing
