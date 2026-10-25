import type {
  AgentHomeStore,
  ArtifactStore,
  JobPublisher,
  MemoryStore,
  ProductAnalytics,
  SandboxProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import type {
  CloudAgentConnection,
  CodexLiveCatalog,
  ComposioProvider,
  ConnectorRegistry,
  FaviconResolver,
  IntegrationProviderSettings,
  McpConnector,
  McpOAuthBroker,
  MemoryProviderResolver,
  MessagingInstallations,
  PiOAuthLogins,
  ProviderCatalogCache,
  PushTokenStore,
  RemoteConnectorDependencies,
  TicketChangeNotifier,
} from "@rakazo/adapters";
import type { Auth } from "@rakazo/auth";
import type { BoardEvents, PrismaClient, ThreadEvents } from "@rakazo/db";
import type { BillingService } from "./billing.js";
import { accountRoutes } from "./routes/account.js";
import { boardsRoutes } from "./routes/boards.js";
import { botsRoutes } from "./routes/bots.js";
import { computerRoutes } from "./routes/computer.js";
import { connectionsRoutes } from "./routes/connections.js";
import { contentRoutes } from "./routes/content.js";
import { createRouterContext } from "./routes/context.js";
import { mcpRoutes } from "./routes/mcp.js";
import { memoryRoutes } from "./routes/memory.js";
import { messagingRoutes } from "./routes/messaging.js";
import { modelsRoutes } from "./routes/models.js";
import { routinesRoutes } from "./routes/routines.js";
import { spacesRoutes } from "./routes/spaces.js";
import { threadsRoutes } from "./routes/threads.js";

export { nextConnectionLabel } from "./model-credentials.js";
export { botIntroPrompt, enqueueBotIntroRun } from "./routes/bots.js";
export { HEARTBEAT_MS, SESSION_RECHECK_MS } from "./routes/shared.js";
export { callMarkerClientNonce } from "./routes/threads.js";

export interface RouterDeps {
  pushTokens: PushTokenStore;
  analytics?: ProductAnalytics;
  cloudAgent?: CloudAgentConnection | null;
  prisma: PrismaClient;
  events: ThreadEvents;
  boardEvents: BoardEvents;
  ticketChanges: TicketChangeNotifier;
  auth: Auth;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
  memory: MemoryStore;
  memoryProviders: MemoryProviderResolver;
  home: AgentHomeStore;
  secrets: SecretStore;
  oauthLogins: PiOAuthLogins;
  /** Live Codex catalog seam; defaults to the shared per-process cache. */
  codexCatalog?: CodexLiveCatalog;
  providerCatalog?: ProviderCatalogCache;
  /** HTTP transport for model connection checks and catalog probes. */
  modelConnectionFetch?: typeof fetch;
  /** Site icons for links; defaults to the per-process cache that fetches them. */
  favicons?: FaviconResolver;
  /**
   * Detached refresh for a stored credential whose bearer expired — the live
   * catalog path calls it instead of refreshing inline. Defaults to the
   * runtime's locked `kickModelCredentialRefresh`; injectable for tests so a
   * catalog read never reaches the real OAuth refresh endpoint.
   */
  refreshExpiredModelCredential?: (
    scope: { userId: string; spaceId: string },
    secretId: string,
    provider: string,
  ) => void;
  integrationSettings?: IntegrationProviderSettings;
  composio?: ComposioProvider;
  mcpOAuth?: McpOAuthBroker;
  /**
   * The API process's MCP connector, used to launch/list an MCP server once so its health
   * is visible (`mcp.servers.test` and the probe after create/update/OAuth). Without it
   * servers are simply never probed from here.
   */
  mcp?: Pick<McpConnector, "probe">;
  connectors: ConnectorRegistry;
  remoteConnectors?: RemoteConnectorDependencies;
  artifacts: ArtifactStore;
  dataDir: string;
  /** Present when the external messaging surface is enabled. */
  messagingInstallations?: MessagingInstallations;
  messaging?: {
    enabled: boolean;
    providers: string[];
    addresses: Record<string, string>;
    openSignup: boolean;
  };
  /** Present only when the deployment bills; self-hosted installs leave it unset. */
  billing?: BillingService;
  env: {
    ticketBoardEnabled?: boolean;
    phoneCallsEnabled?: boolean;
    phoneCallRingSeconds?: number;
    maxUploadSizeBytes?: number;
    agentRuntime: string;
    teamChatJudgeProvider?: string;
    teamChatJudgeModel?: string;
    defaultProvider: string;
    defaultModel: string;
    deploymentModelConfigured?: boolean;
    deploymentModelHostCredentials?: boolean;
    webOrigin: string;
    privacyPolicyUrl?: string;
    screenProxySecret: string;
    sandboxProvider: string;
    gitSha?: string;
    integrationsCatalogUrl?: string;
    mcpAllowPrivateEndpoint?: boolean;
    desktopHostChoiceEnabled?: boolean;
    /** Whether MCP stdio servers can run, and the commands they may launch. */
    mcpStdioEnabled?: boolean;
    mcpStdioAllowedCommands?: string[];
  };
}

export function createRouter(deps: RouterDeps) {
  const ctx = createRouterContext(deps);
  const { os } = ctx;

  return os.router({
    ...accountRoutes(ctx),
    ...spacesRoutes(ctx),
    ...modelsRoutes(ctx),
    ...botsRoutes(ctx),
    ...threadsRoutes(ctx),
    ...computerRoutes(ctx),
    ...memoryRoutes(ctx),
    ...routinesRoutes(ctx),
    ...boardsRoutes(ctx),
    ...mcpRoutes(ctx),
    ...connectionsRoutes(ctx),
    ...messagingRoutes(ctx),
    ...contentRoutes(ctx),
  });
}
