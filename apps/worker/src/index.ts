import { setTimeout as sleep } from "node:timers/promises";
import type { JobPublisher, JobWorkerHost } from "@rakazo/adapter-kit";
import { unwrapEnvFromKeyManager } from "@rakazo/adapters";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { stopOnShutdownSignals } from "@rakazo/core/node/shutdown-signals";
import { startWorkerHealth, watchEventLoopStalls } from "./health.js";
import { createWorkerSecretStore } from "./secret-store.js";

loadRootEnv();
await unwrapEnvFromKeyManager();

import {
  apnsVoipConfig,
  ChatSdkMessagingSurface,
  CodexCatalogCache,
  configuredEmailProvider,
  contentKeyProviderFromEnv,
  createAgentHomeStore,
  createApnsActivityProvider,
  createApnsVoipProvider,
  createArtifactStore,
  createCloudAgentConnection,
  createConnectorRuntime,
  createDeadJobPruner,
  createMediaGenerationProvider,
  createPaymentWalletProvider,
  createPostgresReconciliationLeadership,
  createProductAnalytics,
  createReservedGraphileJobWorkerHost,
  createRoutineRetryNoticeReconciler,
  createRunReconciler,
  createRunRuntime,
  createRunSandbox,
  createRunSecretWriter,
  createTicketChangeNotifier,
  databaseCapacityBackoffMs,
  ExpoPushProvider,
  GraphileJobPublisher,
  homeStorageSweeper,
  InMemoryJobQueue,
  installedMessaging,
  isMessagingSurfaceEnabled,
  messagingEnvFromProcess,
  messagingPlatformsFromEnv,
  PiAgentRuntime,
  PostgresRealtimeFanout,
  PrismaPushTokenStore,
  RunJobPublisher,
  RunStarter,
  RunWorkerHost,
  resolvePiSessionRoot,
  resolveSandboxProvider,
  runRuntimeEnvFromProcess,
  ScriptedAgentRuntime,
  SpaceMemoryProviderResolver,
  sandboxProviderOptionsFromEnv,
  shutdownPiTelemetry,
  UserDevices,
  userDeviceForwardSecret,
  WorkActivities,
  withRunWorker,
  withSecretPersistence,
} from "@rakazo/adapters";
import { resolveSupervisorToken } from "@rakazo/core";
import {
  createBoardEvents,
  createDb,
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
  verifyContentKeys,
} from "@rakazo/db";
import { SERVICE_NAMES } from "@rakazo/logging";
import { createRootLogger } from "@rakazo/logging/axiom";
import { MarkdownMemoryStore } from "@rakazo/memory";

const logger = await createRootLogger(SERVICE_NAMES.worker);

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
  // Set once push delivery is configured below; thread changes before then have no cards.
  let workActivities: WorkActivities | undefined;
  const events = createThreadEvents(prisma, realtime, {
    analytics,
    runSecretWriter: createRunSecretWriter(secrets),
    onThreadChanged: (threadId) => workActivities?.threadChanged(threadId),
  });
  const env = runRuntimeEnvFromProcess(process.env);
  const boardEvents = createBoardEvents(realtime);
  const runtime =
    process.env.AGENT_RUNTIME === "scripted"
      ? new ScriptedAgentRuntime()
      : new PiAgentRuntime({ sessionRoot: resolvePiSessionRoot(env.dataDir) });
  const sandboxProvider = resolveSandboxProvider(process.env);
  const sandbox = await createRunSandbox(sandboxProvider, {
    ...sandboxProviderOptionsFromEnv(process.env),
    supervisorUrl: process.env.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
    supervisorToken: sandboxProvider === "docker" ? resolveSupervisorToken(process.env) : undefined,
    dataDir: env.dataDir,
    prisma,
    secrets,
  });
  const connectors = createConnectorRuntime(env, { prisma, secrets, events });
  // Never poll inbound here: Telegram allows a single getUpdates consumer,
  // and that is the API process, which owns the inbound sink.
  const messagingPlatforms = messagingPlatformsFromEnv(messagingEnvFromProcess(process.env)).filter(
    (platform) => platform.provider !== "slack" || !process.env.SLACK_CLIENT_ID,
  );
  const legacyMessaging = isMessagingSurfaceEnabled(messagingPlatforms, {
    deploymentModelConfigured: env.deploymentModelConfigured,
    openSignup: process.env.MESSAGING_OPEN_SIGNUP === "true",
  })
    ? new ChatSdkMessagingSurface(messagingPlatforms)
    : undefined;
  const memoryProviders = new SpaceMemoryProviderResolver(prisma, secrets);
  const home = createAgentHomeStore(env.dataDir, prisma);
  void home.removeStaleStaging().catch((error) => logger.error("home staging cleanup", error));
  const artifacts = createArtifactStore(env.dataDir, prisma);
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
    ticketBoardEnabled: env.ticketBoardEnabled,
  });
  // One provider instance so emulator launches and polls share the same Map.
  const cloudAgent = createCloudAgentConnection();
  const paymentWallet = await createPaymentWalletProvider();
  // One instance: the executor submits videos and background polls finish them.
  const mediaGeneration = createMediaGenerationProvider();
  // Shared with the reconciler so a stuck wait uses the same push path as a finish notice.
  const pushTokens = new PrismaPushTokenStore(prisma, env.encryptionKey);
  const notifications = new ExpoPushProvider(pushTokens, {
    sessionExpiresAt: (sessionId) => pushSessionExpiresAt(prisma, sessionId),
    jobs,
    accessToken: process.env.EXPO_ACCESS_TOKEN,
    voip: await createApnsVoipProvider(apnsVoipConfig(process.env)),
  });
  const activityPush = await createApnsActivityProvider(apnsVoipConfig(process.env));
  if (activityPush) workActivities = new WorkActivities(prisma, env.encryptionKey, activityPush);
  const email = configuredEmailProvider({
    provider: process.env.EMAIL_PROVIDER?.trim() || undefined,
    apiKey: process.env.EMAIL_API_KEY?.trim() || undefined,
    from: process.env.EMAIL_FROM?.trim() || undefined,
    replyTo: process.env.EMAIL_REPLY_TO?.trim() || undefined,
    smtpUrl: process.env.SMTP_URL?.trim() || undefined,
  });
  const { executor, jobHandlers } = createRunRuntime(env, connectors, {
    mediaGeneration,
    prisma,
    runtime,
    // Live per-account Codex catalog; never refreshes or writes credentials.
    codexCatalog: new CodexCatalogCache(),
    sandbox,
    memory: new MarkdownMemoryStore(prisma),
    memoryProviders,
    home,
    artifacts,
    secretStore: secrets,
    notifications,
    jobs,
    events,
    onTicketChange: ticketChanges,
    // Bots send from their own address through the same provider as account email.
    email,
    messaging,
    cloudAgent,
    // Device sockets live in an API process; the worker forwards to whichever one holds it.
    userDevices:
      process.env.USER_DEVICES_ENABLED === "false"
        ? undefined
        : new UserDevices({
            prisma,
            forwardSecret: userDeviceForwardSecret(env.encryptionKey),
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

  const reconciler = createRunReconciler(
    { prisma, jobs, events, notifications, cloudAgent, paymentWallet, mediaGeneration },
    {
      leadership: createPostgresReconciliationLeadership(pool),
      reconcileRoutineRetryNotices: inMemoryJobs
        ? undefined
        : createRoutineRetryNoticeReconciler(pool, (runId) =>
            executor.notifyRoutineRetryAttemptsExhausted(runId),
          ),
      reconcileHomeStorage: homeStorageSweeper(home),
      reconcileDeadJobs: inMemoryJobs ? undefined : createDeadJobPruner(pool),
    },
  );
  let stopHealth: (() => Promise<void>) | undefined;
  let stopping = false;
  let stopped: Promise<void> | undefined;
  // Every caller waits for the same shutdown, which can take as long as the running jobs do.
  const stop = () =>
    (stopped ??= (async () => {
      stopping = true;
      shutdown.abort();
      stopStallWatch();
      try {
        await stopHealth?.();
        await reconciler.stop();
        await jobHost.stop();
        // A bot's email still on its way finishes before the process exits.
        await email?.drain?.();
        await jobs.close();
        await secrets.close();
        await realtime.close();
        await connectors.mcp.close();
        await connectors.installed.close();
        await prisma.$disconnect().catch(() => undefined);
        await pool.end().catch(() => undefined);
      } finally {
        await analytics?.flush();
        await shutdownPiTelemetry();
        await logger.flush({ timeoutMs: 2_000 });
      }
    })());
  // Exit rather than wait on a hung job that was handed back, which another worker now retries.
  // process.exitCode keeps a crash that arrives while draining from exiting as a clean stop.
  stopOnShutdownSignals(() =>
    stop().then(
      () => process.exit(),
      async (error) => {
        logger.error("worker shutdown failed", error);
        await logger.flush({ timeoutMs: 2_000 });
        process.exit(1);
      },
    ),
  );
  // graphile-worker fires completeJob()/failJobs() without awaiting them. When
  // pool.connect() then hits Postgres 53300 or a saturated pool's checkout timeout,
  // that rejection is unhandled. Exiting on 53300 is a crash loop: Docker restarts
  // the process before Postgres has reaped the old backends. Exiting on a checkout
  // timeout aborts every active run over one transient stall. Stay up on those
  // rejections only — do not resume after uncaughtException (Node leaves the
  // process in an undefined state).
  process.on("uncaughtException", (error) => {
    logger.error("uncaughtException", error);
    process.exitCode = 1;
    void stop().finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandledRejection", reason);
    if (isTooManyDatabaseConnections(reason) || isPoolCheckoutTimeout(reason)) return;
    process.exitCode = 1;
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
