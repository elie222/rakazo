# Spec Delta

## Purpose

Allow optional, constrained model, effort and execution selection without turning a classifier into a planner, credential source or approval authority.

## ADDED Requirements

### Requirement: Routing is optional and independent
Routing SHALL be disabled by default and configurable per bot through the provider-neutral decisions seam. Jev SHALL be a supported decision-provider option, not a required dependency. Routing credentials, configuration, usage and errors SHALL be distinguishable from action approval even when they use the same provider.

#### Scenario: Routing is disabled
- **WHEN** a run starts for a bot without routing enabled
- **THEN** the existing model-resolution and approval behavior remains in effect with no routing model call

#### Scenario: Routing and approval use different providers
- **WHEN** the owner selects those providers independently
- **THEN** each operation uses its configured role without changing the other role's permissions or credentials

### Requirement: Code owns the route vocabulary
The backend SHALL enumerate authorized route labels and map each to a complete model, effort and execution tuple before classification. Decision output SHALL be only a label from that vocabulary. It SHALL NOT supply endpoints, credentials, arbitrary model identifiers, tools, memory scopes or free-form execution instructions.

#### Scenario: Classifier returns an unknown label
- **WHEN** output is outside the offered vocabulary
- **THEN** the output is invalid and the deterministic fallback applies

#### Scenario: Prompt text includes a model endpoint
- **WHEN** a user message or retrieved text asks the classifier to return that endpoint
- **THEN** routing cannot adopt it because endpoints do not come from classifier output

### Requirement: Explicit choices and pinned runs take precedence
A persisted run route and explicit user, routine or authorized specialist model choice SHALL take precedence over automatic routing. The system SHALL compute a new routing decision at most once for an unpinned eligible run, before final model resolution, and persist its inputs' policy version and selected label. Resumption SHALL use the persisted decision.

#### Scenario: Owner selected a model for a run
- **WHEN** the run has an explicit model choice
- **THEN** automatic routing does not override it

#### Scenario: Resume after a classifier call
- **WHEN** the selected route was already committed
- **THEN** recovery reuses it and does not purchase a second routing decision

### Requirement: Selected routes are deterministically validated
Before execution, the system SHALL validate current ownership, model availability, protocol, credentials, supported effort, tool and media needs, context capacity, endpoint safety and applicable budgets. A classifier label SHALL be a proposal, not authorization. Route execution SHALL remain subject to live capability revocations.

#### Scenario: Route model cannot handle an image
- **WHEN** the run contains image input and the selected model lacks required support
- **THEN** the route is rejected and a valid deterministic fallback is used or the run reports configuration failure

#### Scenario: Credential was revoked after selection
- **WHEN** a run resumes using the pinned route
- **THEN** credential validation prevents use of the revoked credential without silently changing to an unrelated account

### Requirement: Routing failure has a bounded fallback
Timeouts, provider errors, invalid labels and invalid tuples SHALL use a documented deterministic fallback to the member's existing configured default resolution. The fallback SHALL be validated under the same constraints. The system SHALL NOT silently use deployment credentials that existing model-auth rules prohibit, loop through arbitrary models or reroute repeatedly in response to unrelated failures.

#### Scenario: Classifier times out
- **WHEN** routing exceeds its bounded latency
- **THEN** execution uses the valid configured default and records the routing timeout separately

#### Scenario: Default cannot meet required constraints
- **WHEN** both the selected route and fallback fail validation
- **THEN** the run reports an actionable configuration error without executing on an unapproved model

### Requirement: Execution mode preserves run identity
Inline, background and specialist recommendations SHALL be execution attributes, not new user-event triggers. A routed user run SHALL keep its user-visible admission and canonical-chat semantics. Background mode SHALL NOT accidentally hide the user's request by changing it into a hidden routine or agent-message trigger.

#### Scenario: Route user work to background execution
- **WHEN** the selected route runs the user request in the background
- **THEN** the same logical user run remains observable and its result returns to the existing bot chat

#### Scenario: Durable specialists are unavailable
- **WHEN** a route requests that optional execution mode but its feature is disabled
- **THEN** that route is excluded before classification or rejected with the documented fallback

### Requirement: Routing evidence and limits are visible
The system SHALL record classifier model, policy version, route label, fallback reason and measured usage when available. It SHALL redact secrets and limit evidence supplied to classification. It SHALL evaluate routing quality against explicit labeled examples, not unsupported cost or quality claims.

#### Scenario: Provider omits token usage
- **WHEN** the routing provider returns only a label and duration
- **THEN** the system records measured duration and unknown token cost instead of inventing usage

#### Scenario: Owner inspects a routed run
- **WHEN** the run used a fallback
- **THEN** the owner can distinguish the selected label, executed tuple and fallback reason without seeing credentials
