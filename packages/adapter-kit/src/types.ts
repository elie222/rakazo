import type { ConnectionCatalogItem, SandboxKind } from "@rakazo/contracts";

export interface AdapterContext {
  operationId: string;
  traceId: string;
  spaceId: string;
  userId: string;
  botId?: string;
  runId?: string;
  /** Opaque fence for releasing a graphical screen without tearing down its replacement. */
  screenLeaseId?: string;
  /** When releasing a screen after cancel, also stop orphaned browser work on that screen. */
  cancelRunWork?: boolean;
  signal: AbortSignal;
  /** Connected external accounts available to this run, including their owning connector. */
  connectedConnections?: ConnectedConnector[];
  /** @deprecated Prefer connectedConnections so providers with the same app slug cannot collide. */
  connectedProviders?: string[];
}

export interface ConnectedConnector {
  id: string;
  connectorId: string;
  externalId: string;
  displayName: string;
  providerRef?: string;
}

export interface AdapterDescriptor<TCapabilities> {
  id: string;
  contractVersion: string;
  adapterVersion: string;
  capabilities: TCapabilities;
}

/**
 * In-process OAuth material for a single agent run. Not part of any RPC or
 * persisted contract. Extra provider fields such as `accountId` are copied
 * through at runtime.
 */
export interface AgentModelOAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

export interface PortableFile {
  path: string;
  content: Uint8Array;
  executable?: boolean;
}

export interface ComputerRef {
  id: string;
  botId: string;
  kind: SandboxKind;
  providerRef: string;
  /** True when the provider created an empty replacement rather than reconnecting existing state. */
  fresh?: boolean;
}

export interface CommandRequest {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  pty?: boolean;
  /** Maximum wall-clock runtime before the command and its descendants are terminated. */
  timeoutMs?: number;
}

export type ProcessEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; code: number };

export interface ScreenRequest {
  view: "stream" | "snapshot";
  /** Request a separately authorized control stream instead of the read-only viewer. */
  interactive?: boolean;
  /** Fences an interactive stream so an older lease cannot revoke its replacement. */
  controlToken?: string;
}

export interface ScreenSession {
  url: string | null;
  mimeType: string;
  close(): Promise<void>;
}

export type ComputerInput =
  | { kind: "key"; key: string; modifiers?: string[] }
  | {
      kind: "pointer";
      x: number;
      y: number;
      button?: "left" | "right";
      type: "move" | "down" | "up" | "click";
    }
  | { kind: "clipboard"; text: string };

export type ComputerAction =
  | ComputerInput
  | { kind: "scroll"; direction: "up" | "down"; amount?: number }
  | { kind: "wait"; ms: number }
  | { kind: "open"; path: string }
  | { kind: "launch"; application: string; uri?: string };

export interface ComputerObservation {
  frameId: string;
  capturedAt: string;
  mimeType: "image/png" | "image/jpeg";
  image: Uint8Array;
  width: number;
  height: number;
  cursor?: { x: number; y: number };
  activeWindow?: { id: string; title?: string };
}

export interface ComputerActionRequest {
  actions: ComputerAction[];
  observe?: boolean;
  settleMs?: number;
}

export interface ComputerActionResult {
  completed: number;
  observation?: ComputerObservation;
}

export interface ComputerFileEntry {
  path: string;
  kind: "file" | "dir";
  size: number;
  executable?: boolean;
}

export type AgentToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" };

/** A provider-neutral tool result an agent runtime can forward without flattening images. */
export interface AgentToolExecutionResult {
  kind: "agent_tool_result";
  content: AgentToolResultContent[];
  details: unknown;
}

export interface ControlLeaseRef {
  leaseId: string;
  holder: "user" | "bot";
  fence: number;
}

export interface SnapshotRef {
  id: string;
  createdAt: string;
}

export interface SandboxCapabilities {
  graphical: boolean;
  pty: boolean;
  snapshots: boolean;
  takeover: boolean;
  persistentHome: boolean;
  /** Distinct graphical screens for concurrent Team bots on one computer. */
  multiScreen?: boolean;
}

export interface ConnectorTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  /** In-process routing metadata. It is never exposed to the model. */
  route?: ConnectorRoute;
}

export interface ConnectorRoute {
  connectorId: string;
  toolName: string;
  resourceId?: string;
  resourceRevision?: string | number;
  /** Source label for lazy catalog name indexes. Never exposed as a model schema field. */
  catalogGroup?: string;
}

export interface ConnectorCall {
  tool: string;
  args: Record<string, unknown>;
  connectionId?: string;
  executionId: string;
  route?: ConnectorRoute;
}

export type ConnectorEvent =
  | { type: "log"; message: string }
  | { type: "result"; data: unknown }
  | { type: "error"; message: string };

export interface ConnectorCapabilities {
  discover: boolean;
  oauth: boolean;
  secretsBrokered: boolean;
}

export type ConnectorCatalogItem = ConnectionCatalogItem;

export interface MemoryReadRequest {
  scope: "bot" | "user";
  botId?: string;
  path?: string;
}

export interface MemorySnapshot {
  documents: Array<{
    id: string;
    path: string;
    content: string;
    revision: number;
    updatedAt?: string;
  }>;
}

export interface MemorySearchRequest {
  query: string;
  scope: "bot" | "user" | "all";
  botId?: string;
}

export interface MemorySearchResult {
  path: string;
  snippet: string;
  score: number;
}

export interface MemoryCommitRequest {
  scope: "bot" | "user";
  botId?: string;
  path: string;
  content: string;
  sourceRunId?: string;
  sourceThreadId?: string;
}

export interface MemoryRevision {
  id: string;
  path: string;
  revision: number;
  content: string;
}

export interface MemoryExportRequest {
  scope: "bot" | "user" | "all";
  botId?: string;
}

export interface MemoryCapabilities {
  search: boolean;
  revisions: boolean;
  markdownPortable: boolean;
}

export type DurableMemoryScope = "isolated" | "shared";

export interface SemanticMemoryCapabilities {
  recall: true;
  save: true;
  purgeHistory: true;
  sharedScope: true;
}

export interface SemanticMemoryResult {
  memory: string;
  score: number;
  updatedAt?: string;
}

export type SemanticMemoryResponse<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface SemanticMemoryRecallRequest {
  query: string;
  scope: DurableMemoryScope;
  botId: string;
  /** Omit until a thread has compacted history; the provider can then skip that namespace. */
  historyGeneration?: number;
  limit: number;
}

export interface SemanticMemorySaveRequest {
  content: string;
  scope: DurableMemoryScope;
  botId: string;
  source: { kind: "durable" } | { kind: "history"; generation: number };
}

export interface SemanticMemoryPurgeHistoryRequest {
  botId: string;
  generations: number[];
}

export interface AgentInputImage {
  name: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  data: Uint8Array;
}

export interface AgentSteeringMessage {
  id: string;
  messageId: string;
  text: string;
  /** Persisted history text before attachment paths are appended. */
  historyText?: string;
  images?: AgentInputImage[];
}

export interface AgentRunRequest {
  botId: string;
  threadId: string;
  runId: string;
  sourceMessageId?: string | null;
  prompt: string;
  instructions: string;
  history: Array<{ id?: string; role: "user" | "assistant" | "system"; content: string }>;
  currentTurnImages?: AgentInputImage[];
  tools: ConnectorTool[];
  model: {
    provider: string;
    id: string;
    apiKey?: string;
    baseUrl?: string;
    /** Preferred thinking effort for reasoning models; clamped to the model’s supported set. */
    thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
    /** In-process OAuth credential from the encrypted store for this run. */
    oauth?: {
      credential: AgentModelOAuthCredential;
      persist?: (credential: AgentModelOAuthCredential) => Promise<void>;
    };
  };
  resumeFromCheckpoint?: string;
  script?: ScriptedTurn[];
  /**
   * Bot-message wakes may finish with no text and no tools (FYI silence).
   * When set, skip synthetic empty-turn fallbacks.
   */
  allowSilentEmpty?: boolean;
  /** Contextual fallback when a non-silent run produces no written response. */
  emptyResponseText?: string;
  executeTool?: (
    name: string,
    args: Record<string, unknown>,
    executionId: string,
    route?: ConnectorRoute,
  ) => Promise<unknown>;
  /** Atomically claim durable user steering at the runtime's next safe turn boundary. */
  claimSteering?: (seenIds: string[]) => Promise<AgentSteeringMessage[]>;
}

export interface ScriptedTurn {
  assistant?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  ask?: { text: string; detail?: string; actions?: Array<{ id: string; label: string }> };
  takeover?: { reason: string };
  files?: Array<{ path: string; content: string }>;
  memory?: Array<{ scope: "bot" | "user"; path: string; content: string }>;
  complete?: boolean;
}

export type AgentRuntimeEvent =
  | { type: "text"; text: string }
  | {
      type: "progress";
      text: string;
      /** Provider-generated tool status rather than assistant-authored narration. */
      activity?: true;
    }
  | { type: "tool"; name: string; args: Record<string, unknown>; executionId: string }
  | {
      type: "ask";
      text: string;
      detail?: string;
      actions?: Array<{ id: string; label: string }>;
    }
  | { type: "takeover"; reason: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; provider: string; model: string }
  | { type: "checkpoint"; blob: string }
  | {
      type: "subagent";
      agentId: string;
      name: string;
      task: string;
      status: "running" | "completed" | "failed";
      progress?: string;
      result?: string;
    }
  | { type: "done"; text?: string };

export interface AgentRuntimeCapabilities {
  streaming: boolean;
  compaction: boolean;
  tools: boolean;
  scripted: boolean;
}

export interface VoiceInfo {
  id: string;
  label: string;
  description?: string;
}

export interface SpeechClip {
  bytes: Uint8Array;
  mimeType: "audio/mpeg" | "audio/wav" | "audio/ogg";
}

export interface VoiceCapabilities {
  catalog: boolean;
  synthesize: boolean;
  transcribe: boolean;
}

export interface VoiceVerifyResult {
  ok: boolean;
  message?: string;
}

export interface VoiceSynthesizeRequest {
  text: string;
  voiceId: string;
  apiKey: string;
  signal?: AbortSignal;
}

export interface VoiceTranscribeRequest {
  audio: Uint8Array;
  mimeType: string;
  apiKey: string;
  signal?: AbortSignal;
}

export interface BackgroundJobPayloads {
  "run.continue": { runId: string };
  "routine.wakeup": { routineId: string; scheduledFor: string };
  "computer.sleep": { computerId: string };
  "computer.control-expire": { computerId: string; leaseId: string };
  "skill.teaching-expire": { skillId: string };
  "history.compact": { threadId: string };
  "messaging.deliver": { runId?: string };
}

export type BackgroundJobName = keyof BackgroundJobPayloads;

export type BackgroundJob = {
  [Name in BackgroundJobName]: {
    name: Name;
    payload: BackgroundJobPayloads[Name];
    availableAt?: Date;
    replaceKey?: string;
  };
}[BackgroundJobName];

export type BackgroundJobHandlers = {
  [Name in BackgroundJobName]: (payload: BackgroundJobPayloads[Name]) => Promise<void>;
};

export interface SecretRecord {
  id: string;
  ciphertext: string;
}

export interface ArtifactPut {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface NotificationMessage {
  kind: "completion" | "failure" | "help" | "takeover";
  title: string;
  body: string;
  botId: string;
  threadId: string;
}

/** A product-authored transactional email, independent of its delivery vendor. */
export interface TransactionalEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MessagingCapabilities {
  direct: boolean;
  groups: boolean;
  typing: boolean;
}

/** One messaging platform behind the chat surface (sendblue, slack, …). */
export interface MessagingPlatformDescriptor {
  provider: string;
  capabilities: MessagingCapabilities;
}

/** Send into an existing conversation, addressed by its opaque thread id. */
export interface MessagingSendRequest {
  threadId: string;
  body: string;
}

export interface MessagingSendResult {
  handle: string;
}

/** Provider-neutral inbound message after platform webhook parsing. */
export interface MessagingInboundMessage {
  type: "message";
  provider: string;
  /** Provider message id; drives replay-safe client nonces downstream. */
  handle: string;
  /** Opaque conversation id — pass back to sendToThread to reply. */
  threadId: string;
  /** True for a 1:1 conversation with the deployment's line/bot. */
  isDirect: boolean;
  /** Sender address within the provider (E.164, Slack user id, …). */
  from: string;
  /** Sender display name when the platform provides one. */
  fromLabel: string | null;
  /** Group/channel display name; null for DMs or when unknown. */
  channelName: string | null;
  /** Group roster addresses when the platform reports them; often empty. */
  participants: string[];
  content: string;
  mediaUrl: string | null;
}

/** Provider-neutral outbound delivery status after platform webhook parsing. */
export interface MessagingOutboundStatus {
  type: "status";
  provider: string;
  handle: string;
  status: string;
}

export type MessagingInboundEvent = MessagingInboundMessage | MessagingOutboundStatus;

export interface WebSearchCapabilities {
  search: boolean;
  /** True when results come from the active model’s native search, not a third-party API. */
  native?: boolean;
  /** True when search works without a hosted search vendor or API key. */
  keyless?: boolean;
}

export interface WebFetchCapabilities {
  fetch: boolean;
  /** True when readable extraction runs without executing page JavaScript. */
  readability: boolean;
}

export interface WebSearchRequest {
  query: string;
  maxResults?: number;
  signal?: AbortSignal;
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebFetchRequest {
  url: string;
  maxChars?: number;
  signal?: AbortSignal;
}

export interface WebFetchResult {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}
