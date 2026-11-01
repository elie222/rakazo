import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { JobPublisher, JobWorkerHost } from "@rakazo/adapter-kit";
import {
  ComposioConnector,
  IntegrationProviderSettings,
  unwrapEnvFromKeyManager,
} from "@rakazo/adapters";
import { phoneCallSettings } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { stopOnShutdownSignals } from "@rakazo/core/node/shutdown-signals";
import { startWorkerHealth, watchEventLoopStalls } from "./health.js";
import { createWorkerSecretStore } from "./secret-store.js";

loadRootEnv();
await unwrapEnvFromKeyManager();

import {
  auditLogConfig,
  ChatSdkMessagingSurface,
  CodexCatalogCache,
  contentKeyProviderFromEnv,
  createAgentHomeStore,
  createArtifactStore,
  createAuditLogReconciler,
  createBackgroundJobHandlers,
  createCloudAgentConnection,
  createConnectorStack,
  createDeadJobPruner,
  createIdleComputerSweeper,
  createJobReconciler,
  createMessagingContextLoader,
  createModelCreditReconciler,
  createPaymentWalletProvider,
  createPostgresReconciliationLeadership,
  createProductAnalytics,
  createReservedGraphileJobWorkerHost,
  createRoutineRetryNoticeReconciler,
  createRunExecutor,
  createRunSandbox,
  createRunSecretWriter,
  createTicketChangeNotifier,
  createWebProvider,
  databaseCapacityBackoffMs,
  deploymentModelUsageLookup,
  ExpoPushProvider,
  GraphileJobPublisher,
  homeStorageSweeper,
  InMemoryJobQueue,
  InstalledConnectorProvider,
  installedMessaging,
  isComposioEnabled,
  isMessagingSurfaceEnabled,
  isPipedreamEnabled,
  McpConnector,
  McpOAuthBroker,
  mcpStdioOptionsFromEnv,
  messagingEnvFromProcess,
  messagingPlatformsFromEnv,
  PiAgentRuntime,
  PipedreamConnector,
  PostgresRealtimeFanout,
  PrismaPushTokenStore,
  pipedreamConfigFromEnv,
  RunJobPublisher,
  RunStarter,
  RunWorkerHost,
  reconcileCloudAgents,
  reconcileComputerUpdates,
  reconcilePurchases,
  resolveDeploymentModel,
  resolvePiSessionRoot,
  resolveSandboxProvider,
  ScriptedAgentRuntime,
  SpaceMemoryProviderResolver,
  sandboxProviderOptionsFromEnv,
  shutdownPiTelemetry,
  UserDevices,
  userDeviceForwardSecret,
  withRunWorker,
  withSecretPersistence,
} from "@rakazo/adapters";
import { resolveEncryptionKey, resolveSupervisorToken, uploadSizeFromEnv } from "@rakazo/core";
import {
  createBoardEvents,
  createDb,
  createSecurityEventPruner,
  createThreadEvents,
  describeRowSecurity,
  installAuditEventStore,
  installSecurityEventStore,
  isPoolCheckoutTimeout,
  isTooManyDatabaseConnections,
  parsePositiveInteger,
  pushSessionExpiresAt,
  rowSecurityWarning,
  runAsSystem,
  securityEventRetentionDays,
  verifyContentKeys,
} from "@rakazo/db";
import { SERVICE_NAMES } from "@rakazo/logging";
import { createRootLogger } from "@rakazo/logging/axiom";
import { MarkdownMemoryStore } from "@rakazo/memory";

const logger = createRootLogger(SERVICE_NAMES.worker);

async function main() {
  const stopStallWatch = watchEventLoopStalls();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const poolMax = parsePositiveInteger(process.env.DB_POOL_MAX, 8);
  // Three queue listeners and reconciliation leadership hold connections. Leave
  // room for job queries and transactions instead of starting a stalled worker.
  if (process.env.WAKEUP_DRIVER !== "memory" && poolMax < 6)
    throw new Error("DB_POOL_MAX must be at least 6 for the Graphile worker");
  // Prisma, queue publishing, the three queue listeners and reconciliation
  // leadership share one bounded pool rather than opening a pool per component.
  // A larger max competes for Postgres max_connections (53300).
  const created = createDb(databaseUrl, {
    poolMax,
    applicationName: "rakazo-worker",
    keyProvider: contentKeyProviderFromEnv(),
  });
  const { pool } = created;
  let { prisma } = created;
  const rowSecurity = rowSecurityWarning(await describeRowSecurity(prisma));
  if (rowSecurity) logger.warn(rowSecurity);
  const realtime = new PostgresRealtimeFanout({
    connectionString: process.env.REALTIME_DATABASE_URL ?? databaseUrl,
    publisher: pool,
  });
  const secrets = await createWorkerSecretStore(process.env, realtime);
  if (secrets.describe().capabilities.degraded)
    logger.warn("Secret storage degraded; encrypted credentials remain available");
  prisma = withSecretPersistence(prisma, secrets);
  installSecurityEventStore(prisma);
  installAuditEventStore(prisma);
  const unreadableMasterKeys = await verifyContentKeys(prisma);
  if (unreadableMasterKeys.length)
    logger.error("Stored space keys need master keys that are not configured", undefined, {
      masterKeyIds: unreadableMasterKeys,
    });
  const analytics = createProductAnalytics();
  const events = createThreadEvents(prisma, realtime, {
    analytics,
    runSecretWriter: createRunSecretWriter(secrets),
  });
  const ticketBoardEnabled = process.env.TICKET_BOARD_ENABLED === "true";
  const boardEvents = createBoardEvents(realtime);
  const dataDir = process.env.DATA_DIR ?? "./data";
  const runtime =
    process.env.AGENT_RUNTIME === "scripted"
      ? new ScriptedAgentRuntime()
      : new PiAgentRuntime({ sessionRoot: resolvePiSessionRoot(dataDir) });
  // Same resolver the API uses, so both processes agree on provider, model and key.
  const { key: deploymentModelKey, configured: deploymentModelConfigured } =
    resolveDeploymentModel();
  const sandboxProvider = resolveSandboxProvider(process.env);
  const sandbox = await createRunSandbox(sandboxProvider, {
    ...sandboxProviderOptionsFromEnv(process.env),
    supervisorUrl: process.env.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
    supervisorToken: sandboxProvider === "docker" ? resolveSupervisorToken(process.env) : undefined,
    dataDir,
    prisma,
  });
  const allowPrivateEndpoint = process.env.MCP_ALLOW_PRIVATE_ENDPOINT === "true";
  const mcpOAuth = new McpOAuthBroker(prisma, secrets, {}, allowPrivateEndpoint);
  const mcpStdio = {
    stdioEnabled: process.env.MCP_STDIO_ENABLED === "true",
    allowedCommands: (process.env.MCP_STDIO_ALLOWED_COMMANDS ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  };
  const mcp = new McpConnector(
    prisma,
    secrets,
    {
      ...mcpStdio,
      ...mcpStdioOptionsFromEnv(process.env),
      events,
      allowPrivateEndpoint,
    },
    mcpOAuth,
  );
  const pipedreamConfig = pipedreamConfigFromEnv({
    pipedreamClientId: process.env.PIPEDREAM_CLIENT_ID,
    pipedreamClientSecret: process.env.PIPEDREAM_CLIENT_SECRET,
    pipedreamProjectId: process.env.PIPEDREAM_PROJECT_ID,
    pipedreamEnvironment: process.env.PIPEDREAM_ENVIRONMENT,
    encryptionKey: resolveEncryptionKey(process.env),
  });
  const pipedream = isPipedreamEnabled(pipedreamConfig)
    ? new PipedreamConnector(pipedreamConfig)
    : undefined;
  // Never poll inbound here: Telegram allows a single getUpdates consumer,
  // and that is the API process, which owns the inbound sink.
  const messagingPlatforms = messagingPlatformsFromEnv(messagingEnvFromProcess(process.env)).filter(
    (platform) => platform.provider !== "slack" || !process.env.SLACK_CLIENT_ID,
  );
  const legacyMessaging = isMessagingSurfaceEnabled(messagingPlatforms, {
    deploymentModelConfigured,
    openSignup: process.env.MESSAGING_OPEN_SIGNUP === "true",
  })
    ? new ChatSdkMessagingSurface(messagingPlatforms)
    : undefined;
  const integrationSettings = new IntegrationProviderSettings(
    prisma,
    secrets,
    resolveEncryptionKey(process.env),
    {
      composio: isComposioEnabled(process.env.COMPOSIO_API_KEY)
        ? new ComposioConnector({ apiKey: process.env.COMPOSIO_API_KEY })
        : undefined,
      pipedream,
    },
  );
  const stack = createConnectorStack(undefined, [
    new InstalledConnectorProvider(prisma, secrets, {}, allowPrivateEndpoint),
    ...integrationSettings.providers(),
    mcp,
  ]);
  integrationSettings.warmDirectories();
  const memoryProviders = new SpaceMemoryProviderResolver(prisma, secrets);
  const home = createAgentHomeStore(dataDir, prisma);
  void home.removeStaleStaging().catch((error) => logger.error("home staging cleanup", error));
  const artifacts = createArtifactStore(dataDir, prisma);
  const shutdown = new AbortController();
  const inMemoryJobs = process.env.WAKEUP_DRIVER === "memory" ? new InMemoryJobQueue() : undefined;
  const runs = new RunStarter(realtime, { signal: shutdown.signal });
  const jobs: JobPublisher =
    inMemoryJobs ?? new RunJobPublisher(prisma, new GraphileJobPublisher(pool, prisma), runs);
  const { messaging } = installedMessaging(
    prisma,
    secrets,
    {
      slackClientId: process.env.SLACK_CLIENT_ID,
      slackClientSecret: process.env.SLACK_CLIENT_SECRET,
      slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
      apiUrl: process.env.API_URL,
    },
    legacyMessaging,
    jobs,
  );
  const ticketChanges = createTicketChangeNotifier({
    boardEvents,
    jobs,
    prisma,
    ticketBoardEnabled,
  });
  // One provider instance so emulator launches and polls share the same Map.
  const cloudAgent = createCloudAgentConnection();
  const paymentWallet = await createPaymentWalletProvider();
  // Shared with the reconciler so a stuck wait uses the same push path as a finish notice.
  const pushTokens = new PrismaPushTokenStore(prisma, resolveEncryptionKey(process.env));
  const notifications = new ExpoPushProvider(pushTokens, {
    sessionExpiresAt: (sessionId) => pushSessionExpiresAt(prisma, sessionId),
    jobs,
    accessToken: process.env.EXPO_ACCESS_TOKEN,
  });
  const executor = createRunExecutor({
    maxUploadSizeBytes: uploadSizeFromEnv(process.env),
    prisma,
    runtime,
    // Live per-account Codex catalog; never refreshes or writes credentials.
    codexCatalog: new CodexCatalogCache(),
    sandbox,
    memory: new MarkdownMemoryStore(prisma),
    memoryProviders,
    home,
    artifacts,
    connector: stack.connector,
    connectors: stack.connector,
    listConnectedPluginSlugs: async (userId) => {
      const provider = await integrationSettings.resolve("composio");
      if (!provider) return [];
      return provider.listConnectedExternalIds({
        userId,
        spaceId: "",
        operationId: "connections.sync",
        traceId: "connections.sync",
        signal: AbortSignal.timeout(15_000),
      });
    },
    secrets: [
      deploymentModelKey ?? "",
      process.env.COMPOSIO_API_KEY ?? "",
      process.env.CURSOR_API_KEY ?? "",
      process.env.TYPESAFE_API_KEY ?? "",
    ].filter(Boolean),
    secretStore: secrets,
    mcpAllowPrivateEndpoint: process.env.MCP_ALLOW_PRIVATE_ENDPOINT === "true",
    deploymentModelKey,
    deploymentModelConfigured,
    dataDir,
    notifications,
    jobs,
    events,
    onTicketChange: ticketChanges,
    ticketBoardEnabled,
    ...phoneCallSettings(process.env),
    messaging: messaging ? createMessagingContextLoader(prisma) : undefined,
    web: createWebProvider(),
    cloudAgent,
    // Device sockets live in an API process; the worker forwards to whichever one holds it.
    userDevices:
      process.env.USER_DEVICES_ENABLED === "false"
        ? undefined
        : new UserDevices({
            prisma,
            forwardSecret: userDeviceForwardSecret(resolveEncryptionKey(process.env)),
          }),
    paymentWallet,
    shutdownSignal: shutdown.signal,
  });

  const jobHost: JobWorkerHost =
    inMemoryJobs ??
    withRunWorker(
      new RunWorkerHost(prisma, realtime, runs, { pool }),
      createReservedGraphileJobWorkerHost(pool, {
        concurrency: parsePositiveInteger(process.env.GRAPHILE_WORKER_CONCURRENCY, 4),
      }),
    );

  const jobHandlers = createBackgroundJobHandlers({
    executor,
    prisma,
    sandbox,
    home,
    artifacts,
    jobs,
    events,
    // Deploys run the old and new worker side by side, and every container runs node as the same pid.
    workerId: `${hostname()}:${process.pid}`,
    runtime,
    secretStore: secrets,
    memoryProviders,
    deploymentModelKey,
    deploymentModelConfigured,
    messaging,
    cloudAgent,
    paymentWallet,
    notifications,
  });
  const reconciler = createJobReconciler({
    prisma,
    jobs,
    events,
    notifications,
    leadership: createPostgresReconciliationLeadership(pool),
    reconcileModelCredits: createModelCreditReconciler({
      prisma,
      lookup: deploymentModelUsageLookup(),
    }),
    reconcileCloudAgents: () => reconcileCloudAgents({ prisma, jobs, cloudAgent }),
    reconcilePurchases: () => reconcilePurchases({ prisma, jobs, paymentWallet }),
    reconcileComputerUpdates: () => reconcileComputerUpdates({ prisma, jobs }),
    reconcileRoutineRetryNotices: inMemoryJobs
      ? undefined
      : createRoutineRetryNoticeReconciler(pool, (runId) =>
          executor.notifyRoutineRetryAttemptsExhausted(runId),
        ),
    reconcileSecurityEventRetention: createSecurityEventPruner(
      prisma,
      securityEventRetentionDays(),
    ),
    reconcileAuditLog: createAuditLogReconciler(prisma, auditLogConfig()),
    reconcileHomeStorage: homeStorageSweeper(home),
    reconcileIdleComputers: createIdleComputerSweeper({ prisma, jobs }),
    reconcileDeadJobs: inMemoryJobs ? undefined : createDeadJobPruner(pool),
  });
  let stopHealth: (() => Promise<void>) | undefined;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    shutdown.abort();
    stopStallWatch();
    try {
      await stopHealth?.();
      await reconciler.stop();
      await jobHost.stop();
      await jobs.close();
      await secrets.close();
      await realtime.close();
      await mcp.close();
      await prisma.$disconnect().catch(() => undefined);
      await pool.end().catch(() => undefined);
    } finally {
      await analytics?.flush();
      await shutdownPiTelemetry();
      await logger.flush({ timeoutMs: 2_000 });
    }
  };
  stopOnShutdownSignals(stop);
  // graphile-worker fires completeJob()/failJobs() without awaiting them. When
  // pool.connect() then hits Postgres 53300 or a saturated pool's checkout timeout,
  // that rejection is unhandled. Exiting on 53300 is a crash loop: Docker restarts
  // the process before Postgres has reaped the old backends. Exiting on a checkout
  // timeout aborts every active run over one transient stall. Stay up on those
  // rejections only — do not resume after uncaughtException (Node leaves the
  // process in an undefined state).
  process.on("uncaughtException", (error) => {
    logger.error("uncaughtException", error);
    void stop().finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandledRejection", reason);
    if (isTooManyDatabaseConnections(reason) || isPoolCheckoutTimeout(reason)) return;
    void stop().finally(() => process.exit(1));
  });

  // Direct runs may already be active while the scheduler waits for capacity.
  // Keep retrying without exiting; the handlers above drain them on shutdown.
  for (let attempt = 0; !stopping; attempt += 1) {
    try {
      await jobHost.start(jobHandlers);
      break;
    } catch (error) {
      if (stopping) return;
      if (!isTooManyDatabaseConnections(error)) {
        await stop();
        throw error;
      }
      logger.error("worker job host start waiting on database capacity", error);
      await sleep(databaseCapacityBackoffMs(attempt), undefined, { signal: shutdown.signal }).catch(
        () => undefined,
      );
    }
  }
  if (stopping) return;
  reconciler.start();
  stopHealth = startWorkerHealth(reconciler.lastCompletedAt);

  logger.info("worker ready", { degraded: secrets.describe().capabilities.degraded ?? false });
}

// The worker only does cross-tenant work: job dispatch, reconcilers, leadership and
// realtime, all keyed by ids rather than a signed-in user. This is its one
// row-level security bypass; jobs re-enter it explicitly (see wakeup.ts).
runAsSystem("worker process", main).catch(async (error) => {
  logger.error("worker startup failed", error);
  await logger.flush({ timeoutMs: 2_000 });
  // jobHost.start retries 53300 without bound above, so a saturated Postgres at
  // that step does not reach here. Other startup failures still exit.
  process.exit(1);
});
