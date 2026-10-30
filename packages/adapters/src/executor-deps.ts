import type {
  AgentContextStrategy,
  AgentHomeStore,
  AgentRuntime,
  ArtifactStore,
  AutoReviewProvider,
  BrowserProvider,
  ConnectorProvider,
  JobPublisher,
  ManagedConnectorProvider,
  MediaGenerationProvider,
  MemoryStore,
  NotificationProvider,
  PaymentWalletProvider,
  SandboxProvider,
  SecretStore,
  WebProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient, RunLease, ThreadEvents } from "@rakazo/db";
import type { CloudAgentConnection } from "./cloud-agent-factory.js";
import type { McpStdioPolicy } from "./mcp-transport.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";
import type { CodexLiveCatalog } from "./pi-codex-catalog.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import type { TicketChangeNotifier } from "./ticket-changes.js";
import type { UserDeviceGateway } from "./user-device-protocol.js";

export interface ExecutorDeps {
  maxUploadSizeBytes?: number;
  contextStrategy?: AgentContextStrategy;
  prisma: PrismaClient;
  events: ThreadEvents;
  runtime: AgentRuntime;
  sandbox: SandboxProvider;
  memory: MemoryStore;
  memoryProviders: MemoryProviderResolver;
  home: AgentHomeStore;
  artifacts?: ArtifactStore;
  connector?: ConnectorProvider;
  connectors?: {
    managed(id: string): ManagedConnectorProvider | undefined;
    managedProviders?(): ManagedConnectorProvider[];
  };
  secrets: string[];
  secretStore: SecretStore;
  billingEnabled?: boolean;
  deploymentModelKey?: string;
  /** The deployment default model can run; see resolveDeploymentModel. */
  deploymentModelConfigured?: boolean;
  dataDir?: string;
  notifications?: NotificationProvider;
  jobs: JobPublisher;
  /** Publishes board-change signals and wakes ticket owners; absent disables both. */
  onTicketChange?: TicketChangeNotifier;
  ticketBoardEnabled?: boolean;
  phoneCallsEnabled?: boolean;
  phoneCallCooldownMinutes?: number;
  phoneCallRingSeconds?: number;
  /** Messaging surface; absent means zero identity queries and no chat prompts. */
  messaging?: { hasIdentity(botId: string): Promise<boolean> };
  listConnectedPluginSlugs?: (userId: string) => Promise<string[]>;
  /** Builtin web_search / web_fetch. Defaults to keyless HTTP when omitted. */
  web?: WebProvider;
  mediaGeneration?: MediaGenerationProvider;
  /** Page browser (DOM refs) on the bot computer. Defaults to the sandbox live browser when supported. */
  browser?: BrowserProvider;
  secretHttp?: RemoteTransportDependencies;
  /** Allow RFC1918 / Docker-network MCP URLs when the operator enabled the escape. */
  mcpAllowPrivateEndpoint?: boolean;
  /** Which stdio MCP servers this deployment runs; absent runs none. */
  mcpStdio?: McpStdioPolicy;
  /** Remote cloud coding agents. Null/omit means tools stay uninjected. */
  cloudAgent?: CloudAgentConnection | null;
  /** The deployment's payment wallet. Null/omit means purchase tools stay uninjected. */
  paymentWallet?: PaymentWalletProvider | null;
  /** Optional Auto Review verifier. When omitted, the factory selects from env (llm | jev | scripted). */
  autoReview?: AutoReviewProvider;
  /**
   * Live Codex model catalog; when present, a statically excluded Codex model
   * can still run for the OAuth account whose backend lists it.
   */
  codexCatalog?: CodexLiveCatalog;
  /** The run starter's connected desktop; absent never offers user_computer_shell. */
  userDevices?: UserDeviceGateway;
  /** Aborted when createApp stop() begins so in-flight continueRun boot waits exit promptly. */
  shutdownSignal?: AbortSignal;
  /** Set by withRunLease for one attempt; that run's history writes carry its lease. */
  runLease?: RunLease & { runId: string };
}
