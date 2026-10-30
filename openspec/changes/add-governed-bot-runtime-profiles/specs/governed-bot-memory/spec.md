# Spec Delta

## Purpose

Provide useful persistent and evolving bot memory while preserving source evidence, authorized sharing, correction rights and truthful deletion and provider status.

## ADDED Requirements

### Requirement: Memory scope is authorized before retrieval
The system SHALL distinguish bot-private, explicitly shared and conversation-derived memory. It SHALL enforce owner, space, bot, sharing and history-generation boundaries before provider retrieval and again before returning results. New profiles SHALL default to private learned memory; existing shared-memory settings SHALL remain unchanged until edited.

#### Scenario: A bot recalls private knowledge
- **WHEN** one bot requests facts saved privately by another bot
- **THEN** no private content is sent to its model or returned by history or semantic search

#### Scenario: Shared access is revoked
- **WHEN** a bot loses access to a shared scope
- **THEN** later recall excludes that scope, including cached results and pending background work

### Requirement: Derived knowledge carries evidence and status
Newly derived memories SHALL record source references, scope, provenance type, review status and relevant source generation. The system SHALL distinguish user statements, observed results, third-party claims and model inferences. A model inference SHALL NOT be presented as an owner-confirmed fact solely because it was saved repeatedly.

#### Scenario: Reflect on a failed task
- **WHEN** a model proposes a lesson from an unsuccessful tool result
- **THEN** the candidate includes that result and its failure status rather than describing the procedure as verified

#### Scenario: Imported legacy memory lacks evidence
- **WHEN** a legacy note has no recoverable source references
- **THEN** the system labels its provenance as legacy or unknown instead of inventing citations

### Requirement: Continuous chat receives fresh bounded memory
The system SHALL refresh applicable memory at bounded run or turn boundaries without requiring a new visible chat. Recall SHALL be available before history compaction. Explicit approved corrections SHALL override stale derived context. Provider recall SHALL respect a prompt budget and SHALL NOT automatically ingest whole transcripts.

#### Scenario: Use new memory in the same chat
- **WHEN** an owner approves a memory update and later sends a message in the existing chat
- **THEN** the bot can use the updated revision without clearing history or opening another chat

#### Scenario: Recall before the first compaction
- **WHEN** a new chat needs a relevant previously approved memory
- **THEN** recall is eligible even though that chat has no compaction summary

### Requirement: Provider-neutral optional semantic memory
The core product SHALL work with no external semantic provider. Optional providers, including Hindsight, SHALL use the same scoped contract and declare recall, write, reflect, export and deletion capabilities truthfully. Provider errors SHALL NOT grant broader access or prevent ordinary chat that does not require that provider.

#### Scenario: Semantic provider is unavailable
- **WHEN** optional semantic recall times out
- **THEN** the run can proceed with authorized local memory and records the degraded recall status without claiming a successful search

#### Scenario: Connect a read-only provider
- **WHEN** a provider supports recall but not write or forgetting
- **THEN** unsupported operations are unavailable and the settings disclose the limitation

### Requirement: Retention and mutation are controlled
Automatic writes SHALL be limited to explicitly enabled policy and authorized source windows. Shared-memory mutations SHALL require owner confirmation unless they are direct authenticated owner edits. Revision conflicts SHALL NOT silently overwrite notes. Learned facts SHALL NOT edit persona, operational authority or executable code.

#### Scenario: Reflection proposes shared knowledge
- **WHEN** reflection proposes an entry for a shared memory pool
- **THEN** the entry stays pending until an authorized owner confirms its content and sharing scope

#### Scenario: Concurrent note edits
- **WHEN** a learning promotion targets a document changed since candidate creation
- **THEN** it is marked conflicted or regenerated rather than overwriting the current document

### Requirement: Corrections and forgetting affect future use
Owners SHALL be able to inspect evidence, correct, supersede and forget learned entries. The system SHALL immediately suppress a forgotten entry and its known derivatives from product retrieval and new learning. Provider deletion SHALL have a visible pending, completed or failed status; failure SHALL NOT be described as completed erasure.

#### Scenario: Correct an erroneous preference
- **WHEN** the owner replaces an inferred preference with an explicit correction
- **THEN** later recall favors the correction, suppresses the superseded entry and does not relearn it from unchanged source material

#### Scenario: Remote deletion fails
- **WHEN** forgetting succeeds locally but the provider cannot confirm deletion
- **THEN** the product excludes the entry and reports remote deletion as pending or failed

### Requirement: Clear chat and forget knowledge remain distinct
Clearing a chat SHALL invalidate its conversation-derived summaries, queued learning windows and specialist context for the prior generation. It SHALL preserve explicitly saved durable memory unless the owner separately chooses to forget it. Deleting a bot, space or account SHALL follow the selected retention policy and propagate scoped deletion work.

#### Scenario: Clear during reflection
- **WHEN** a chat is cleared while a reflection job uses its prior generation
- **THEN** that job cannot promote or re-retain knowledge from the cleared generation

#### Scenario: Keep an explicitly saved note
- **WHEN** an owner clears chat without selecting durable-memory removal
- **THEN** the saved note remains available and the operation explains that distinction

### Requirement: Provider retention resists stale retries
Memory ingestion and deletion SHALL use stable source identities, generation checks and durable status. A delayed ingestion retry SHALL NOT recreate content after its source or scope is deleted or revoked. Export SHALL include authorized local memory, evidence metadata and honest provider coverage without secret values.

#### Scenario: Ingestion completes after deletion starts
- **WHEN** an old asynchronous retain operation completes after its source was forgotten
- **THEN** its results remain suppressed and a cleanup action reconciles the late remote write

#### Scenario: Provider cannot export all remote data
- **WHEN** an owner exports memory from that provider
- **THEN** the export identifies the local records and coverage gap rather than claiming completeness
