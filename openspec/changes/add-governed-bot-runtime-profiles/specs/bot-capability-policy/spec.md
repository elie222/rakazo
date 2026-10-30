# Spec Delta

## Purpose

Make a bot's assigned tools, skills, connections and workspace limits effective at execution time across interactive, delegated and unattended work.

## ADDED Requirements

### Requirement: Discovery and execution share a policy
The system SHALL enforce the effective bot policy when listing, resolving and executing capabilities. Direct calls, lazy catalogs, aliases, commands, extension calls, nested calls and background runs SHALL obey the same restrictions. Unknown or unassigned operations SHALL fail closed.

#### Scenario: Guess an unavailable tool name
- **WHEN** a model calls a tool absent from the bot's allowed set by its raw name or alias
- **THEN** execution is denied even if the tool was omitted from the visible catalog

#### Scenario: Resolve a tool through a catalog
- **WHEN** a catalog wrapper resolves an operation disabled for the bot
- **THEN** the resolved operation is denied before approval or external dispatch

### Requirement: Skills have explicit availability modes
The system SHALL distinguish a reusable skill library from a bot's assignments. Existing bots SHALL retain a documented legacy-library mode until changed. New profiles SHALL support explicit skill selection. Skill catalog, read, create, update, archive and shared-write operations SHALL enforce ownership, assignment, mutability and scope.

#### Scenario: Preserve existing skill access
- **WHEN** a pre-profile bot is upgraded without owner edits
- **THEN** its legacy-library skill access remains available and the mode is visible

#### Scenario: Read an unassigned skill
- **WHEN** an explicit-selection bot requests an unassigned skill by identifier
- **THEN** the system denies the read without returning its content

#### Scenario: A bot learns a new private skill
- **WHEN** an authorized learning promotion creates a bot-private skill
- **THEN** only that bot receives the assignment and the skill is not published to the whole library

### Requirement: MCP assignments remain authoritative
The system SHALL preserve per-bot MCP server assignments and tool allowlists at discovery and execution. Profiles and extensions SHALL reference these authorized resources rather than starting a parallel ungoverned connection. Server or tool revisions SHALL invalidate approvals that no longer match the approved operation.

#### Scenario: An extension requests an unassigned MCP operation
- **WHEN** an extension references a server the bot cannot use
- **THEN** the operation is denied without connecting through a second path

#### Scenario: A server changes while approval is pending
- **WHEN** a resumed action targets a different resource revision or operation than the approval
- **THEN** the old approval does not authorize the changed action

### Requirement: Authority only narrows through delegation
Specialists, reflection workers and initiative runs SHALL inherit no more authority than the initiating bot and the specific task permits. Skill text, remembered facts, extension settings and model routing SHALL NOT grant permissions. Changing authority SHALL require the existing owner approval boundary.

#### Scenario: A specialist requests broader tools
- **WHEN** delegated work asks for a tool excluded from its parent policy or delegated subset
- **THEN** the request is denied instead of inheriting deployment-wide tools

#### Scenario: Learned text contains a permission instruction
- **WHEN** retrieved memory says that a blocked operation is allowed
- **THEN** the deterministic policy still blocks the operation

### Requirement: Credential references obey existing scope
Profiles SHALL contain references and permitted uses, never credential values. Managed requests SHALL resolve credentials through the existing vault and destination checks. Revocation SHALL prevent future use. No feature SHALL claim secrecy from a bot shell or trusted extension to which a value is deliberately exposed.

#### Scenario: Export a profile with connections
- **WHEN** a profile references credentials or authenticated MCP servers
- **THEN** the export contains only redacted references that require authorized rebinding on import

#### Scenario: Remove a credential during a run
- **WHEN** the owner removes a credential before the next managed request
- **THEN** the next request cannot inject that credential; an already-started request is reported as potentially still in flight

### Requirement: Workspace privacy is explicit
The system SHALL distinguish dedicated and shared computers, homes and browser sessions. A private profile SHALL NOT be presented as private filesystem or browser isolation when it uses a shared computer. Cloning or restoring a profile SHALL NOT silently copy browser sessions or switch computer sharing mode.

#### Scenario: Select a shared computer
- **WHEN** an owner assigns a bot to a shared computer
- **THEN** the settings identify the sharing boundary and do not promise per-bot filesystem or cookie secrecy

#### Scenario: Clone a profile with a signed-in browser
- **WHEN** a bot profile is cloned
- **THEN** its browser cookies and login state are not included in the portable profile

### Requirement: Revocations override snapshots
The system SHALL revalidate current denies, membership, connection revocation and extension withdrawal before protected actions. It SHALL stop later actions and cancel queued work where required without rewriting historical run snapshots. Approval SHALL NOT override an explicit current deny.

#### Scenario: Withdraw extension approval
- **WHEN** the operator revokes an installed extension
- **THEN** new and resumed calls from that extension are blocked, affected work is stopped, and prior audit records remain available

#### Scenario: Remove space membership
- **WHEN** an actor loses access before queued work begins
- **THEN** that work cannot continue using the actor's former authority
