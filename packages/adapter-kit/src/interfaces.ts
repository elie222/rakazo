import type {
  AdapterContext,
  AdapterDescriptor,
  AgentRunRequest,
  AgentRuntimeCapabilities,
  AgentRuntimeEvent,
  ArtifactPut,
  BackgroundJob,
  BackgroundJobHandlers,
  CommandRequest,
  ComputerActionRequest,
  ComputerActionResult,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ConnectorCall,
  ConnectorCapabilities,
  ConnectorCatalogItem,
  ConnectorEvent,
  ConnectorTool,
  ControlLeaseRef,
  MemoryCapabilities,
  MemoryCommitRequest,
  MemoryExportRequest,
  MemoryReadRequest,
  MemoryRevision,
  MemorySearchRequest,
  MemorySearchResult,
  MemorySnapshot,
  MessagingInboundEvent,
  MessagingPlatformDescriptor,
  MessagingSendRequest,
  MessagingSendResult,
  NotificationMessage,
  PortableFile,
  ProcessEvent,
  SandboxCapabilities,
  ScreenRequest,
  ScreenSession,
  SecretRecord,
  SemanticMemoryCapabilities,
  SemanticMemoryPurgeHistoryRequest,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
  SnapshotRef,
  SpeechClip,
  TransactionalEmail,
  VoiceCapabilities,
  VoiceInfo,
  VoiceSynthesizeRequest,
  VoiceTranscribeRequest,
  VoiceVerifyResult,
  WebFetchCapabilities,
  WebFetchRequest,
  WebFetchResult,
  WebSearchCapabilities,
  WebSearchHit,
  WebSearchRequest,
} from "./types.js";

export interface SandboxProvider {
  describe(): AdapterDescriptor<SandboxCapabilities>;
  /** Allocate or reconnect the computer, returning its reference before fallible setup. */
  provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
    },
    context: AdapterContext,
  ): Promise<ComputerRef>;
  /** Perform idempotent provider setup after the lifecycle has captured the reference. */
  prepare(computer: ComputerRef, context: AdapterContext): Promise<void>;
  execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent>;
  inspectBackgroundWork?(
    computer: ComputerRef,
    markerId: string,
    context: AdapterContext,
  ): Promise<"active" | "idle" | "unknown">;
  connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession>;
  setScreenControl?(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ): Promise<void>;
  sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void>;
  observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation>;
  act(
    computer: ComputerRef,
    request: ComputerActionRequest,
    context: AdapterContext,
  ): Promise<ComputerActionResult>;
  listFiles(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]>;
  readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array>;
  writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext): Promise<void>;
  exportWorkspace(computer: ComputerRef, context: AdapterContext): AsyncIterable<PortableFile>;
  importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void>;
  snapshot(computer: ComputerRef, context: AdapterContext): Promise<SnapshotRef>;
  keepAlive?(computer: ComputerRef): Promise<void>;
  /** Drop a single-screen graphical claim for this bot so another Team bot can use the display. */
  releaseScreen?(computer: ComputerRef, context: AdapterContext): Promise<void>;
  stop(computer: ComputerRef, context: AdapterContext): Promise<void>;
  destroy(computer: ComputerRef, context: AdapterContext): Promise<void>;
}

export interface ConnectorProvider {
  describe(): AdapterDescriptor<ConnectorCapabilities>;
  discoverTools(context: AdapterContext): Promise<ConnectorTool[]>;
  /** Resolve a lazy catalog call to its authoritative authorized tool before approval. */
  resolveCall?(
    call: ConnectorCall,
    context: AdapterContext,
  ): Promise<{ call: ConnectorCall; tool: ConnectorTool } | undefined>;
  execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent>;
}

export interface ConnectionAuthProvider {
  describe(): AdapterDescriptor<{ oauth: boolean }>;
  begin(
    request: { provider: string; redirectUrl: string },
    context: AdapterContext,
  ): Promise<{ authorizationUrl: string | null; state: string }>;
  complete(
    request: { state: string; code?: string },
    context: AdapterContext,
  ): Promise<{ connectionRef: string }>;
  revoke(connectionRef: string, context: AdapterContext): Promise<void>;
}

/** A connector that also owns an end-user app catalog and connection lifecycle. */
export interface ManagedConnectorProvider
  extends ConnectorProvider,
    Omit<ConnectionAuthProvider, "describe"> {
  catalog(context: AdapterContext, query?: string): Promise<ConnectorCatalogItem[]>;
  listConnectedExternalIds(context: AdapterContext): Promise<string[]>;
  connectionReady(context: AdapterContext, externalId: string): Promise<boolean>;
  warmDirectory?(): Promise<void>;
}

export interface MemoryStore {
  describe(): AdapterDescriptor<MemoryCapabilities>;
  read(request: MemoryReadRequest, context: AdapterContext): Promise<MemorySnapshot>;
  search(request: MemorySearchRequest, context: AdapterContext): Promise<MemorySearchResult[]>;
  commit(request: MemoryCommitRequest, context: AdapterContext): Promise<MemoryRevision>;
  exportMarkdown(
    request: MemoryExportRequest,
    context: AdapterContext,
  ): AsyncIterable<PortableFile>;
  importMarkdown(
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<MemoryRevision>;
}

/** Optional semantic memory. Durable Markdown memory remains owned by MemoryStore. */
export interface SemanticMemoryProvider {
  describe(): AdapterDescriptor<SemanticMemoryCapabilities>;
  recall(
    request: SemanticMemoryRecallRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>>;
  save(
    request: SemanticMemorySaveRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse>;
  purgeHistory(
    request: SemanticMemoryPurgeHistoryRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse>;
}

export interface AgentRuntime {
  describe(): AdapterDescriptor<AgentRuntimeCapabilities>;
  run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent>;
  abort(runId: string): Promise<void>;
}

export interface ModelProvider {
  describe(): AdapterDescriptor<{ catalog: boolean; byok: boolean }>;
  listModels(): Promise<Array<{ provider: string; id: string; label: string; billing: string }>>;
}

export interface JobPublisher {
  enqueue(job: BackgroundJob): Promise<void>;
  cancel(key: string): Promise<void>;
  close(): Promise<void>;
}

export interface JobWorkerHost {
  start(handlers: BackgroundJobHandlers): Promise<void>;
  stop(): Promise<void>;
}

export interface AgentHomeStore {
  describe(): AdapterDescriptor<{ revisions: boolean }>;
  checkout(botId: string, dest: string, context: AdapterContext): Promise<string>;
  commit(botId: string, src: string, context: AdapterContext): Promise<string>;
  restore(botId: string, revision: string, dest: string, context: AdapterContext): Promise<void>;
  exportHome(botId: string, context: AdapterContext): AsyncIterable<PortableFile>;
  readFile(
    botId: string,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<string>;
  writeFile(botId: string, path: string, content: string, context: AdapterContext): Promise<void>;
  list(
    botId: string,
    path: string,
    context: AdapterContext,
  ): Promise<Array<{ path: string; kind: "file" | "dir"; size: number }>>;
}

export interface ArtifactStore {
  describe(): AdapterDescriptor<{ stream: boolean }>;
  put(artifact: ArtifactPut, context: AdapterContext): Promise<{ id: string; hash: string }>;
  get(id: string, context: AdapterContext): Promise<Uint8Array>;
  remove(id: string, context: AdapterContext): Promise<void>;
}

export interface SecretStore {
  describe(): AdapterDescriptor<{ rotate: boolean }>;
  /** Optional recordId binds ciphertext AAD to the persisted secret/session row id. */
  put(plaintext: string, context: AdapterContext, recordId?: string): Promise<SecretRecord>;
  get(id: string, context: AdapterContext): Promise<string>;
  redact(value: string): string;
}

export interface RealtimeFanout {
  describe(): AdapterDescriptor<{ distributed: boolean; push: boolean }>;
  publish(topic: string, payload: string): Promise<void>;
  subscribe(topic: string, onMessage: (payload: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export interface NotificationProvider {
  describe(): AdapterDescriptor<{ push: boolean; email: boolean }>;
  send(message: NotificationMessage, context: AdapterContext): Promise<void>;
}

/** Outbound account and security email. Product code owns content; adapters own delivery. */
export interface TransactionalEmailProvider {
  describe(): AdapterDescriptor<{ transactional: boolean }>;
  send(message: TransactionalEmail): Promise<void>;
  /** Wait for accepted in-flight deliveries before a graceful shutdown completes. */
  drain?(): Promise<void>;
}

export interface ExecutionRunner {
  describe(): AdapterDescriptor<{ cloud: boolean; selfHosted: boolean; desktop: boolean }>;
  dispatch(runId: string, target: "cloud" | "self-hosted" | "desktop"): Promise<void>;
}

export interface VoiceProvider {
  describe(): AdapterDescriptor<VoiceCapabilities>;
  verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult>;
  listVoices(apiKey: string, context: AdapterContext): Promise<VoiceInfo[]>;
  synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip>;
  transcribe?(request: VoiceTranscribeRequest, context: AdapterContext): Promise<{ text: string }>;
}

/**
 * Deployment-wide external chat surface: one bot presence across messaging
 * platforms (iMessage/SMS, Slack, WhatsApp, …). Conversations are addressed
 * by opaque provider-prefixed thread ids ("sendblue:…", "slack:C1:…"), so
 * orchestration never sees platform wire formats. Webhook verification and
 * payload translation live behind handleWebhook, per platform.
 */
export interface MessagingSurface {
  describe(): AdapterDescriptor<{ providers: string[] }>;
  /** Enabled platforms and what each supports. */
  platforms(): MessagingPlatformDescriptor[];
  /**
   * Verify and process one platform webhook request. Parsed events reach the
   * sink registered via onInbound before the returned response resolves.
   * Returns null for a provider this surface does not host.
   */
  handleWebhook(provider: string, request: Request): Promise<Response> | null;
  /** Register the single downstream consumer of inbound events. */
  onInbound(sink: (event: MessagingInboundEvent) => Promise<void>): void;
  sendToThread(
    request: MessagingSendRequest,
    context: AdapterContext,
  ): Promise<MessagingSendResult>;
  /** Resolve (or create) the 1:1 thread for a provider address. */
  openDirectThread(provider: string, address: string, context: AdapterContext): Promise<string>;
  /**
   * Best-effort "…" typing bubbles for 1:1 chats. Cosmetic: never gates
   * message delivery, and silently no-ops on platforms without support.
   */
  sendTyping(threadId: string, context: AdapterContext): Promise<void>;
}

/**
 * Provider-neutral web search. Builtin `web_search` routes here so backends
 * (keyless HTTP, model-native search, future paid APIs) can be swapped without
 * changing tool names or the executor.
 */
export interface WebSearchProvider {
  describe(): AdapterDescriptor<WebSearchCapabilities>;
  search(request: WebSearchRequest, context: AdapterContext): Promise<WebSearchHit[]>;
}

/**
 * Provider-neutral page fetch. Builtin `web_fetch` routes here. Read-only:
 * no JS execution, no headless browser.
 */
export interface WebFetchProvider {
  describe(): AdapterDescriptor<WebFetchCapabilities>;
  fetch(request: WebFetchRequest, context: AdapterContext): Promise<WebFetchResult>;
}

/** Convenience when one adapter owns both search and fetch. */
export interface WebProvider extends WebSearchProvider, WebFetchProvider {
  describe(): AdapterDescriptor<WebSearchCapabilities & WebFetchCapabilities>;
}
