import { setTimeout as sleep } from "node:timers/promises";
import type { JobPublisher, JobQueueOrder, JobWorkerHost } from "@rakazo/adapter-kit";
import { unwrapEnvFromKeyManager } from "@rakazo/adapters";
import { configuredMeetingMedia } from "@rakazo/adapters/meeting-media";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { stopOnShutdownSignals } from "@rakazo/core/node/shutdown-signals";
import { startWorkerHealth } from "./health.js";
import { createWorkerSecretStore } from "./secret-store.js";

loadRootEnv();
await unwrapEnvFromKeyManager();

import {
  apnsVoipConfig,
  ChatSdkMessagingSurface,
  CodexCatalogCache,
  configuredBotEmailProvider,
  configuredEmailProvider,
  configuredMeetingProviders,
  configuredMeetingSpaces,
  contentKeyProviderFromEnv,
  createAgentHomeStore,
  createApnsActivityProvider,
  createApnsVoipProvider,
  createArtifactStore,
  createCloudAgentConnection,
  createConnectorRuntime,
  createDeadJobPruner,
  createLifecycleEmailSender,
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
  drainRuns,
  ExpoPushProvider,
  GraphileJobPublisher,
  homeStorageSweeper,
  InMemoryJobQueue,
  installedMessaging,
  isMessagingSurfaceEnabled,
  MeetingCalendarService,
  MeetingService,
  machineCleanupRecords,
  meetingCalendarScope,
  messagingEnvFromProcess,
  messagingPlatformsFromEnv,
  PiAgentRuntime,
  PostgresRealtimeFanout,
  PrismaPushTokenStore,
  RUN_DRAIN_MS,
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
  withHostComputerScreen,
  withRunWorker,
  withSecretPersistence,
  withSecretWriteAhead,
} from "@rakazo/adapters";
import { abortableDelay } from "@rakazo/core";
import { resolveMeetingSigningKey, resolveSupervisorToken } from "@rakazo/core/node/secrets-guard";
import {
  createBoardEvents,
  createDb,
  createThreadEvents,
  databaseCapacityBackoffMs,
  databaseOutage,
  describeRowSecurity,
  installAuditEventStore,
  installSecurityEventStore,
  observeThreadChanges,
  parsePositiveInteger,
  pushSessionExpiresAt,
  rowSecurityWarning,
  runAsSystem,
  timeZoneWarning,
  verifyContentKeys,
} from "@rakazo/db";
import { bestEffort, SERVICE_NAMES } from "@rakazo/logging";
import { createRootLogger } from "@rakazo/logging/axiom";
import { watchEventLoopStalls } from "@rakazo/logging/event-loop";
import { MarkdownMemoryStore } from "@rakazo/memory";

const logger = await createRootLogger(SERVICE_NAMES.worker);

async function main() {
  const stopStallWatch = watchEventLoopStalls("worker.event_loop_stalled");
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
  const timeZone = await bestEffort("database time zone check", timeZoneWarning(prisma));
  if (timeZone) logger.warn(timeZone);
  // Set once push delivery is configured below; thread changes before then have no cards.
  let workActivities: WorkActivities | undefined;
  // Every thread change this process commits also updates its users' live status cards.
  const realtime = observeThreadChanges(
    new PostgresRealtimeFanout({
      connectionString: process.env.REALTIME_DATABASE_URL ?? databaseUrl,
      publisher: pool,
    }),
    (threadId) => workActivities?.threadChanged(threadId),
  );
  // The queue is built from this client below; a secret written or dropped before then gets no
  // backup.
  let secretCleanupJobs: JobPublisher | undefined;
  const secrets = withSecretWriteAhead(
    await createWorkerSecretStore(process.env, realtime),
    () => secretCleanupJobs,
  );
  if (secrets.describe().capabilities.degraded)
    logger.warn("Secret storage degraded; encrypted credentials remain available");
  prisma = withSecretPersistence(prisma, secrets, () => secretCleanupJobs);
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
  const env = runRuntimeEnvFromProcess(process.env);
  const boardEvents = createBoardEvents(realtime);
  const runtime =
    process.env.AGENT_RUNTIME === "scripted"
      ? new ScriptedAgentRuntime()
      : new PiAgentRuntime({ sessionRoot: resolvePiSessionRoot(env.dataDir) });
  const sandboxProvider = resolveSandboxProvider(process.env);
  const sandboxOptions = sandboxProviderOptionsFromEnv(process.env);
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
  const home = createAgentHomeStore(env.dataDir, prisma, process.env, env.workspaceSaveLimits);
  void home.removeStaleStaging().catch((error) => logger.error("home staging cleanup", error));
  const artifacts = createArtifactStore(env.dataDir, prisma);
  const shutdown = new AbortController();
  const inMemoryJobs = process.env.WAKEUP_DRIVER === "memory" ? new InMemoryJobQueue() : undefined;
  // A stop lets the runs this worker is executing end their turn before they are handed back.
  // Only where the deployment says a stopping worker is left alone that long: one killed
  // within seconds would leave a run mid-turn waiting for its lease to expire.
  const runDrain = drainRuns(
    shutdown.signal,
    process.env.RUN_DRAIN_ENABLED === "true" ? RUN_DRAIN_MS : 0,
  );
  const runs = new RunStarter(realtime, { signal: shutdown.signal });
  const jobs: JobPublisher & JobQueueOrder =
    inMemoryJobs ?? new RunJobPublisher(prisma, new GraphileJobPublisher(pool, prisma), runs);
  secretCleanupJobs = jobs;
  const connectors = createConnectorRuntime(env, { prisma, secrets, events, jobs });
  const sandbox = await createRunSandbox(sandboxProvider, {
    ...sandboxOptions,
    supervisorUrl: process.env.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
    supervisorToken: sandboxProvider === "docker" ? resolveSupervisorToken(process.env) : undefined,
    dataDir: env.dataDir,
    prisma,
    secrets,
    unreferencedMachines: machineCleanupRecords(jobs),
  });
  const { messaging, installations: messagingInstallations } = installedMessaging(
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
    deploymentLabs: env.deploymentLabs,
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
  const email = configuredBotEmailProvider({
    smtpUrl: process.env.BOT_EMAIL_SMTP_URL?.trim() || undefined,
    domain: process.env.INBOUND_EMAIL_DOMAIN?.trim() || undefined,
  });
  // Account mail, for the lifecycle mails the queue holds. Without it, or with product mail
  // switched off since they were queued, those jobs are dropped.
  // Read only when product mail is on, so incomplete mail settings never stop a worker that
  // sends none.
  const accountEmail =
    process.env.WELCOME_EMAIL_ENABLED === "true"
      ? configuredEmailProvider({
          provider: process.env.EMAIL_PROVIDER?.trim() || undefined,
          apiKey: process.env.EMAIL_API_KEY?.trim() || undefined,
          from: process.env.EMAIL_FROM?.trim() || undefined,
          replyTo: process.env.EMAIL_REPLY_TO?.trim() || undefined,
          smtpUrl: process.env.SMTP_URL?.trim() || undefined,
        })
      : undefined;
  const lifecycleEmail = accountEmail
    ? createLifecycleEmailSender({ prisma, email: accountEmail, jobs, analytics })
    : undefined;
  const { meeting: meetingProvider, calendar: calendarProvider } =
    await configuredMeetingProviders();
  const meetingMedia = meetingProvider && configuredMeetingMedia();
  const meetings =
    meetingProvider &&
    new MeetingService({
      prisma,
      jobs,
      events,
      provider: meetingProvider,
      spaceIds: configuredMeetingSpaces(meetingProvider),
      buildJoin: meetingMedia?.buildJoin,
    });
  const meetingCalendar =
    calendarProvider &&
    meetings &&
    new MeetingCalendarService({
      prisma,
      jobs,
      provider: calendarProvider,
      webOrigin: process.env.WEB_ORIGIN?.trim() || "http://127.0.0.1:5173",
      oauthStateKey: resolveMeetingSigningKey(),
      enabled: (spaceId) => meetings.enabled(spaceId),
      buildJoin: meetingMedia?.buildJoin ?? ((input) => input),
      publish: async ({ spaceId, userId }) => {
        await events.publishSpaceChange?.(meetingCalendarScope(spaceId, userId), "meetingCalendar");
      },
    });
  const { executor, jobHandlers, messagingDelivery, teamChat } = createRunRuntime(env, connectors, {
    mediaGeneration,
    meetingWork: meetings?.work.bind(meetings),
    meetingCalendarSync:
      meetingCalendar && (({ connectionId }) => meetingCalendar.sync(connectionId)),
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
    // Bots use a separate sending connection from account email.
    email,
    lifecycleEmail,
    messaging,
    isMessagingInstallationActive: messagingInstallations
      ? (id: string) => messagingInstallations.isActive(id)
      : undefined,
    cloudAgent,
    // Device sockets live in an API process; the worker forwards to whichever one holds it.
    userDevices: withHostComputerScreen(
      process.env.USER_DEVICES_ENABLED === "false"
        ? undefined
        : new UserDevices({
            prisma,
            forwardSecret: userDeviceForwardSecret(env.encryptionKey),
          }),
      {
        prisma,
        sandboxKind: sandboxProvider,
        url: sandboxOptions.hostComputerUrl,
        token: sandboxOptions.hostComputerToken,
      },
    ),
    paymentWallet,
    stoppingSignal: shutdown.signal,
    shutdownSignal: runDrain.signal,
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
    {
      prisma,
      secretStore: secrets,
      jobs,
      events,
      notifications,
      cloudAgent,
      userCloudAgents: connectors.userCloudAgents,
      paymentWallet,
      mediaGeneration,
    },
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
    { messagingDelivery, teamChat },
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
        await accountEmail?.drain?.();
        await jobs.close();
        await secrets.close();
        await realtime.close();
        await connectors.mcp.close();
        await connectors.installed.close();
        await bestEffort("disconnect database client", prisma.$disconnect());
        // Once the job hosts have stopped, only work they gave up on can still hold a
        // connection, such as Graphile's listener whose UNLISTEN never answered, so the
        // wait is bounded; the process exits right after.
        await Promise.race([bestEffort("close database pool", pool.end()), abortableDelay(10_000)]);
      } finally {
        await analytics?.flush();
        await shutdownPiTelemetry();
        await logger.flush({ timeoutMs: 2_000 });
      }
    })());
  // A failure hands the running turns back at once, as a process that may not be sound should.
  const stopNow = () => {
    runDrain.end();
    return stop();
  };
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
  // graphile-worker fires completeJob()/failJobs() without awaiting them. When the
  // database is unavailable (53300, a saturated pool's checkout timeout, read-only
  // during a failover) that rejection is unhandled. Exiting on 53300 is a crash loop:
  // Docker restarts the process before Postgres has reaped the old backends. Exiting
  // on a checkout timeout aborts every active run over one transient stall. Stay up on
  // those rejections only, logged once per outage — do not resume after
  // uncaughtException (Node leaves the process in an undefined state).
  process.on("uncaughtException", (error) => {
    logger.error("uncaughtException", error);
    process.exitCode = 1;
    void stopNow().finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    if (databaseOutage.failed(reason, "job queue")) return;
    logger.error("unhandledRejection", reason);
    process.exitCode = 1;
    void stopNow().finally(() => process.exit(1));
  });

  // Direct runs may already be active while the scheduler waits for the database: out of
  // capacity, read-only or unreachable. Keep retrying without exiting, logging the outage
  // once; the handlers above drain them on shutdown.
  for (let attempt = 0; !stopping; attempt += 1) {
    try {
      await jobHost.start(jobHandlers);
      databaseOutage.succeeded();
      break;
    } catch (error) {
      if (stopping) return;
      if (!databaseOutage.failed(error, "worker start", { fromDatabaseConnection: true })) {
        await stopNow();
        throw error;
      }
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
