import { createHmac } from "node:crypto";
import type {
  AgentContextStrategy,
  AgentRuntime,
  BillingProvider,
  BrowserProvider,
  ConnectorProvider,
  JobPublisher,
  ManagedConnectorProvider,
  MessagingSurface,
  NotificationProvider,
  RealtimeFanout,
  SandboxProvider,
  TransactionalEmailProvider,
  WebProvider,
} from "@rakazo/adapter-kit";
import type {
  ComposioProvider,
  ConnectorRegistry,
  createRunExecutor,
  PluginRepoFetcher,
  PluginTextReader,
  RemoteConnectorDependencies,
  RunRuntimeEnv,
  UserDeviceGateway,
} from "@rakazo/adapters";
import {
  BillingEmulator,
  CodexCatalogCache,
  closeServerFoundation,
  configuredMessaging,
  contentKeyProviderFromEnv,
  createAgentHomeStore,
  createArtifactStore,
  createCloudAgentConnection,
  createConnectorRuntime,
  createDubPartnerProgram,
  createLifecycleEmailSender,
  createMediaGenerationProvider,
  createMeetingServices,
  createPaymentWalletProvider,
  createPushDelivery,
  createRunReconciler,
  createRunRuntime,
  createRunSandbox,
  createTicketChangeNotifier,
  drainRuns,
  GraphileJobPublisher,
  InMemoryJobQueue,
  InMemoryRealtimeFanout,
  machineCleanupRecords,
  messagingAddresses,
  ObjectAgentHomeStore,
  PiAgentRuntime,
  PiOAuthLogins,
  PostgresRealtimeFanout,
  piSessionsRoot,
  RUN_DRAIN_MS,
  RunJobPublisher,
  RunStarter,
  resolveDeploymentModel,
  ScriptedAgentRuntime,
  SpaceMemoryProviderResolver,
  StripeBillingProvider,
  startServerFoundation,
  stripeBillingConfigFromEnv,
  T3CODE_LINK_SCHEMES,
  UserDeviceHub,
  UserDevices,
  userDeviceForwardSecret,
  userDeviceInternalAddress,
  verifyModelServesAgents,
  withHostComputerScreen,
} from "@rakazo/adapters";
import { createAuth, emailCopyAvailable, isBlockedAuthPath } from "@rakazo/auth";
import type { ModelCredential } from "@rakazo/contracts";
import {
  isLocalhostOrLoopbackIp,
  PLUGIN_SUBMISSIONS_PATH,
  SERVER_BUILD_HEADER,
} from "@rakazo/contracts";
import { encryptionKeyWarning } from "@rakazo/core/node/secrets-guard";
import type { Pool, PrismaClient } from "@rakazo/db";
import {
  configureProviderTransactionPool,
  createBoardEvents,
  createDb,
  createPool,
  parsePositiveInteger,
  runAsSystem,
} from "@rakazo/db";
import type { Logger } from "@rakazo/logging";
import {
  bestEffort,
  createServiceLogger,
  getLogger,
  installLogger,
  SERVICE_NAMES,
} from "@rakazo/logging";
import { requestLogging } from "@rakazo/logging/hono";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { finishStalledOrganizationDeletions } from "./account/account-deletion.js";
import { mountAccountExportRoute } from "./account/account-export.js";
import { mountAccountImportRoute } from "./account/account-import.js";
import { mountAuditExportRoute } from "./account/audit-export.js";
import { mountAuthCapabilities } from "./auth/auth-capabilities.js";
import {
  authLibraryLogger,
  emptyAuthBodyAsJson,
  withAuthLibraryFailures,
} from "./auth/auth-library-failures.js";
import { scimDirectory } from "./auth/directory-route.js";
import { requestSessions } from "./auth/request-session.js";
import { createAuthResponseAudit } from "./auth/security-audit.js";
import { accountLifecycleHooks } from "./auth/session-hooks.js";
import { isTrustedOrigin, mobileAuthOrigins } from "./auth/trusted-origins.js";
import { mountUserDeviceRoutes } from "./auth/user-devices.js";
import { createBillingService } from "./billing/billing.js";
import { mountBillingRoutes } from "./billing/billing-webhook.js";
import { createSpeechSummarizer } from "./calls/speech-summary.js";
import { mountVoiceHttpRoutes } from "./calls/voice.js";
import { homeRetentionSweep } from "./computers/home-retention.js";
import { localSignupAdmitter, mountLocalComputerHost } from "./computers/local-settings.js";
import { mountScreenTarget } from "./computers/screen-proxy.js";
import { storeInboundAttachment } from "./content/artifacts.js";
import { mountSharedPages } from "./content/shared-pages.js";
import { apiEmail, emailErrorLogger } from "./email/email.js";
import { mountEmailInboundRoute } from "./email/email-inbound.js";
import { lifecycleEmailScheduler } from "./email/lifecycle-email.js";
import { marketingEmailRoutes, sendWelcomeEmail } from "./email/marketing-email.js";
import { sendReferralEmails } from "./email/referral-email.js";
import type { AppEnv } from "./env.js";
import { loadEnv, withEnvOverrides } from "./env.js";
import { mountAppAssociation } from "./http/app-association.js";
import {
  clientIpMiddleware,
  createClientIpResolver,
  defaultTrustedProxies,
  requestClientIp,
  withClientIp,
} from "./http/client-ip.js";
import { databaseProbe, healthRoutes } from "./http/health.js";
import { startHourlySweep } from "./http/hourly-sweep.js";
import { trackInFlightRequests } from "./http/in-flight-requests.js";
import { mountApiRequestBodyLimits } from "./http/request-body-limit.js";
import { mountRpcRoute } from "./http/rpc-route.js";
import { mountScriptAssets } from "./http/script-assets.js";
import { SYSTEM_CONTEXT_PATHS } from "./http/system-context-routes.js";
import { moveMcpArgsIntoSecrets } from "./integrations/mcp-args-migration.js";
import { pluginSubmissionRoutes } from "./integrations/plugin-submissions.js";
import { mountMeetingCalendarHttp } from "./meetings/calendar/calendar-routes.js";
import { createMeetingAnswers } from "./meetings/meeting-answers.js";
import { mountMeetingWebhook } from "./meetings/meeting-routes.js";
import { startMessagingRuntime } from "./messaging/messaging-runtime.js";
import { settleWithTimeout } from "./messaging/team-chat-startup.js";
import { recordSignInEnded } from "./models/model-connect-analytics.js";
import { createRouter, routerEnv } from "./router.js";
import { handleHttpError } from "./rpc-errors.js";
import type { SpaceDeletionDeps } from "./spaces/space-deletion.js";
import { afterSpaceDeparture } from "./spaces/space-departure.js";
import { cspReportRoutes } from "./telemetry/csp-report.js";
import { monitoringRoutes } from "./telemetry/monitoring.js";
import { mountWebhookHttpRoutes } from "./webhooks/webhook.js";

// A stop that hands runs back is allowed 30 seconds before the process is killed.
const REQUEST_DRAIN_MS = 20_000;

export interface AppHandles {
  app: Hono;
  prisma: PrismaClient;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
  composio?: ComposioProvider;
  connectors: ConnectorRegistry;
  messaging?: MessagingSurface;
  email?: TransactionalEmailProvider;
  notifications: NotificationProvider;
  executor: ReturnType<typeof createRunExecutor>;
  runtime: AgentRuntime;
  awaitIdle?: () => Promise<void>;
  backgroundFailures?: () => Array<{ name: string; count: number }>;
  /** Node `upgrade` listener for desktop device sockets; absent when the feature is off. */
  handleUpgrade?: UserDeviceHub["handleUpgrade"];
  /**
   * Stops this process. With `letRunsFinish`, the runs it is executing first end their turn, for
   * up to RUN_DRAIN_MS, while it claims nothing new; otherwise, or when a later stop arrives
   * without it, they are handed back at once. Either way, new runs stop at once; the rest waits
   * for `connectionsClosed`, which settles once the server has stopped taking requests.
   */
  stop: (options?: { letRunsFinish?: boolean; connectionsClosed?: Promise<void> }) => Promise<void>;
}

// Startup and everything it schedules (pollers, team chat, the in-memory job
// queue, retries) runs across tenants. Requests start without a context and get
// one per route: tenant for signed-in procedures, system for auth and webhooks.
export function createApp(overrides: CreateAppOverrides = {}): Promise<AppHandles> {
  return runAsSystem("api startup and background work", () => buildApp(overrides));
}

type CreateAppOverrides = Partial<AppEnv> & {
  prisma?: PrismaClient;
  realtime?: RealtimeFanout;
  sandbox?: SandboxProvider;
  composio?: ComposioProvider;
  /** Test-only connector providers registered beside the configured ones. */
  connectors?: ConnectorProvider[];
  pipedream?: ManagedConnectorProvider;
  messaging?: MessagingSurface;
  email?: TransactionalEmailProvider;
  notifications?: NotificationProvider;
  billing?: BillingProvider;
  remoteConnectors?: RemoteConnectorDependencies;
  pluginRepoFetcher?: PluginRepoFetcher;
  pluginMarketplaceRead?: PluginTextReader;
  modelConnectionFetch?: typeof fetch;
  logger?: Logger;
  runtime?: AgentRuntime;
  contextStrategy?: AgentContextStrategy;
  /** Test-only stand-in for desktops connected to this server. */
  userDevices?: UserDeviceGateway;
  /** Test-only present moment the agent is told. */
  now?: () => Date;
  /** Test-only web search and fetch. */
  web?: WebProvider;
  /** Test-only page browser. */
  browser?: BrowserProvider;
};

async function buildApp(overrides: CreateAppOverrides): Promise<AppHandles> {
  const {
    prisma: prismaOverride,
    realtime: realtimeOverride,
    sandbox: sandboxOverride,
    composio: composioOverride,
    connectors: connectorOverrides = [],
    pipedream: pipedreamOverride,
    messaging: messagingOverride,
    email: emailOverride,
    notifications: notificationsOverride,
    billing: billingOverride,
    remoteConnectors,
    modelConnectionFetch,
    pluginRepoFetcher,
    pluginMarketplaceRead,
    logger: loggerOverride,
    runtime: runtimeOverride,
    contextStrategy,
    userDevices: userDevicesOverride,
    web,
    browser,
    now,
    ...envOverrides
  } = overrides;
  const env = withEnvOverrides(loadEnv(process.env), envOverrides);
  const runtimeEnv: RunRuntimeEnv = { ...env, inboundEmailDomain: env.inboundEmail?.domain };
  const logger = loggerOverride ?? createServiceLogger({ service: SERVICE_NAMES.api });
  installLogger(logger);
  const poolMax = parsePositiveInteger(process.env.DB_POOL_MAX, 4);
  configureProviderTransactionPool(poolMax);
  const created = prismaOverride
    ? { prisma: prismaOverride, pool: undefined }
    : createDb(env.databaseUrl, {
        poolMax,
        applicationName: "rakazo-api",
        keyProvider: contentKeyProviderFromEnv(),
        encryptContent: env.contentEncryption,
      });
  // Built before anything listens, so a bad TRUSTED_PROXIES entry stops startup.
  const clientIp = createClientIpResolver({
    // Unset trusts the proxies a stack is built with: on loopback or on the API's own networks.
    // Trusting none would make the web proxy every client, one sign-in rate-limit bucket for all.
    trustedProxies: env.trustedProxies.length > 0 ? env.trustedProxies : defaultTrustedProxies(),
    header: env.clientIpHeader,
  });
  const weakEncryptionKey = encryptionKeyWarning(process.env);
  if (weakEncryptionKey) logger.warn(weakEncryptionKey);
  const foundation = await startServerFoundation({
    prisma: created.prisma,
    realtime:
      realtimeOverride ??
      (created.pool
        ? new PostgresRealtimeFanout({
            connectionString: env.realtimeDatabaseUrl,
            publisher: created.pool,
          })
        : new InMemoryRealtimeFanout()),
    encryptionKey: env.encryptionKey,
  });
  const { prisma, realtime, secrets, analytics, events } = foundation;
  const partnerProgram = env.dubApiKey ? createDubPartnerProgram(env.dubApiKey) : undefined;
  const boardEvents = createBoardEvents(realtime);

  const jobKind = env.wakeupDriver;
  const inMemoryJobs = jobKind === "memory" ? new InMemoryJobQueue() : undefined;
  // prismaOverride skips createDb, so there is no shared pool; keep a bounded one for jobs.
  let ownedJobPool: Pool | undefined;
  if (!inMemoryJobs && !created.pool) {
    ownedJobPool = createPool(env.databaseUrl, {
      poolMax: parsePositiveInteger(process.env.DB_POOL_MAX, 4),
      applicationName: "rakazo-api-jobs",
    });
  }
  const jobPool = created.pool ?? ownedJobPool;
  const shutdown = new AbortController();
  const runDrain = drainRuns(shutdown.signal, RUN_DRAIN_MS);
  // Chat starts in the process that receives it; the worker only takes what this one can't.
  const runs = inMemoryJobs ? undefined : new RunStarter(realtime, { signal: shutdown.signal });
  const jobs =
    inMemoryJobs ??
    new RunJobPublisher(
      prisma,
      new GraphileJobPublisher(
        jobPool ??
          (() => {
            throw new Error("Graphile job publisher requires a PostgreSQL pool");
          })(),
        prisma,
      ),
      runs!,
    );
  foundation.useJobs(jobs);
  const ticketChanges = createTicketChangeNotifier({
    boardEvents,
    jobs,
    prisma,
    deploymentLabs: env.deploymentLabs,
  });
  const sandbox: SandboxProvider =
    sandboxOverride ??
    (await createRunSandbox(env.sandboxProvider, {
      ...env.sandboxOptions,
      supervisorUrl: env.sandboxSupervisorUrl,
      supervisorToken: env.sandboxSupervisorToken,
      dataDir: env.dataDir,
      prisma,
      secrets,
      unreferencedMachines: machineCleanupRecords(jobs),
    }));
  const memoryProviders = new SpaceMemoryProviderResolver(prisma, secrets);
  const oauthLogins = new PiOAuthLogins<ModelCredential>(undefined, { prisma, secrets }, (ended) =>
    recordSignInEnded(analytics, ended),
  );
  const home = createAgentHomeStore(env.dataDir, prisma, process.env, env.workspaceSaveLimits);
  void home.removeStaleStaging().catch((error) => getLogger().error("home staging cleanup", error));
  const artifacts = createArtifactStore(env.dataDir, prisma);
  const memory = new MarkdownMemoryStore(prisma);
  const { messaging, installations: messagingInstallations } = messagingOverride
    ? { messaging: messagingOverride, installations: undefined }
    : configuredMessaging({
        prisma,
        secrets,
        jobs,
        env,
        deploymentModelConfigured: env.deploymentModelConfigured,
        openSignup: env.messagingOpenSignup,
        // This process registers the inbound sink, so it must hold Telegram's getUpdates connection.
        pollInboundMessages: true,
      });
  const { email, localEmailEmulator, lifecycleEmailKinds, botEmail } = apiEmail(env, {
    override: emailOverride,
    singleProcess: Boolean(inMemoryJobs),
  });
  const onEmailError = emailErrorLogger("transactional email delivery failed");
  const stripeBilling = stripeBillingConfigFromEnv(env);
  const localBillingEmulator =
    !billingOverride && !stripeBilling && env.billingEmulator
      ? new BillingEmulator({ modelCredits: true })
      : undefined;
  if (localBillingEmulator && !isLocalhostOrLoopbackIp(env.apiHost)) {
    throw new Error("BILLING_EMULATOR requires API_HOST to be a loopback host");
  }
  const billingProvider: BillingProvider | undefined =
    billingOverride ??
    (stripeBilling ? new StripeBillingProvider(stripeBilling) : localBillingEmulator);
  // One instance: chat runs submit videos and, in single-process mode, background polls finish them.
  const mediaGeneration = createMediaGenerationProvider();
  const billing = billingProvider
    ? createBillingService({
        prisma,
        provider: billingProvider,
        sandbox,
        mediaGeneration,
        realtime,
        webOrigin: env.webOrigin,
        managedModelsAvailable: resolveDeploymentModel().configured,
        analytics,
        partnerProgram,
        scheduleLifecycleEmail:
          lifecycleEmailKinds.length > 0
            ? lifecycleEmailScheduler({
                kinds: lifecycleEmailKinds,
                prisma,
                jobs,
                webOrigin: env.webOrigin,
                origin: env.authUrl,
                secret: env.authSecret,
              })
            : undefined,
      })
    : undefined;
  const modelCreditsEnabled = billing?.modelCreditsEnabled ?? false;
  await prisma.deploymentSettings.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      modelCreditsEnabled,
    },
    update: { modelCreditsEnabled },
  });
  const connectors = createConnectorRuntime(
    runtimeEnv,
    { prisma, secrets, events, jobs },
    {
      network: remoteConnectors,
      composio: composioOverride,
      pipedream: pipedreamOverride,
      connectors: connectorOverrides,
    },
  );
  const { mcpOAuth, mcp, pipedream, integrationSettings, stack, userCloudAgents } = connectors;
  const baseRuntime =
    runtimeOverride ??
    (env.agentRuntime === "scripted"
      ? new ScriptedAgentRuntime()
      : new PiAgentRuntime({
          sessionRoot: env.piSessionRecording ? piSessionsRoot(env.dataDir) : undefined,
        }));
  const { pushTokens, notifications, workActivities } = await createPushDelivery({
    prisma,
    jobs,
    encryptionKey: env.encryptionKey,
    expoAccessToken: env.expoAccessToken,
    apnsVoip: env.apnsVoip,
    notifications: notificationsOverride,
  });
  foundation.useWorkActivities(workActivities);
  const {
    provider: meetingProvider,
    media: meetingMediaConfig,
    meetings,
    calendar: meetingCalendar,
  } = await createMeetingServices({ prisma, jobs, events, webOrigin: env.webOrigin });
  // Every Space deletion, from account deletion, the organization sweep or an import rollback,
  // tears down the same bots, computers, meetings and secrets.
  const spaceDeletionDeps: SpaceDeletionDeps = {
    prisma,
    sandbox,
    home,
    jobs,
    memoryProviders,
    artifacts,
    dataDir: env.dataDir,
    messagingInstallations,
    secrets,
    meetings,
    meetingCalendar,
  };
  const userDeviceSecret = userDeviceForwardSecret(env.encryptionKey);
  const userDeviceHub = env.userDevicesEnabled
    ? new UserDeviceHub({ prisma, address: userDeviceInternalAddress(env.apiHost, env.port) })
    : undefined;
  const userDevices = userDeviceHub
    ? new UserDevices({ prisma, forwardSecret: userDeviceSecret, hub: userDeviceHub })
    : undefined;
  const deviceSessions = {
    prisma,
    devices: userDevices ?? new UserDevices({ prisma, forwardSecret: userDeviceSecret }),
  };
  const directory = await scimDirectory(prisma, env);
  const auth = createAuth(prisma, {
    directoryProvisioning: Boolean(directory),
    analytics,
    partnerProgram,
    passwordAuth: env.passwordAuth,
    breachedPasswordCheck: env.breachedPasswordCheck,
    oidc: env.oidc,
    social: env.social,
    secret: env.authSecret,
    baseURL: env.authUrl,
    webOrigin: env.webOrigin,
    signupsEnabled: env.signupsEnabled,
    signupAllowlist: env.signupAllowlist,
    admitsSignup: env.desktopStackToken ? localSignupAdmitter(env.desktopStackToken) : undefined,
    email,
    logger: authLibraryLogger("auth.request.failed"),
    onEmailError,
    afterSignIn:
      email && emailCopyAvailable("welcome")
        ? (userId, headers) =>
            sendWelcomeEmail(
              {
                prisma,
                email,
                origin: env.authUrl,
                secret: env.authSecret,
                onError: emailErrorLogger("welcome email delivery failed"),
              },
              userId,
              headers,
            )
        : undefined,
    extraOrigins: [...mobileAuthOrigins(env.nodeEnv), ...env.extraAuthOrigins],
    androidAppCertFingerprints: env.passkeyAndroidCertFingerprints,
    ...accountLifecycleHooks({
      spaceDeletion: spaceDeletionDeps,
      events,
      billing,
      pushTokens,
      workActivities,
      deviceSessions,
    }),
  });
  const oauthTokenUpgrade = auth
    .encryptStoredOAuthTokens()
    .catch((error) => getLogger().error("oauth token encryption upgrade failed", error));
  const mcpArgsMove = moveMcpArgsIntoSecrets(prisma, secrets, { signal: shutdown.signal })
    .then(({ moved }) => {
      if (moved) getLogger().info("mcp server arguments encrypted", { count: moved });
    })
    .catch((error) => {
      if (!shutdown.signal.aborted) getLogger().error("mcp server arguments move failed", error);
    });
  // One provider instance so emulator launches and polls share the same Map.
  const cloudAgent = createCloudAgentConnection({
    CLOUD_AGENT_PROVIDER: env.cloudAgentProvider,
    CURSOR_API_KEY: env.cursorApiKey,
    CLOUD_AGENT_SPACE_ID: env.cloudAgentSpaceId,
  });
  const paymentWallet = await createPaymentWalletProvider({
    PAYMENT_WALLET_PROVIDER: env.paymentWalletProvider,
    PAYMENT_WALLET_CLIENT_ID: env.paymentWalletClientId,
  });
  // One cache serves models.list, selection validation, and run-time model
  // resolution alike, so a list call warms the run path in this process.
  const codexCatalog = new CodexCatalogCache();
  // The computers bots may reach: paired desktops, and this server's own screen when it has one.
  const botUserDevices =
    userDevicesOverride ??
    withHostComputerScreen(userDevices, {
      prisma,
      sandboxKind: env.sandboxProvider,
      url: env.sandboxOptions.hostComputerUrl,
      token: env.sandboxOptions.hostComputerToken,
    });
  const { runtime, executor, jobHandlers, messagingDelivery, teamChat, pageRevisions } =
    createRunRuntime(runtimeEnv, connectors, {
      billingEnabled: modelCreditsEnabled,
      mediaGeneration,
      meetingWork: meetingProvider && meetings.work.bind(meetings),
      meetingCalendarSync:
        meetingCalendar && (({ connectionId }) => meetingCalendar.sync(connectionId)),
      contextStrategy,
      prisma,
      runtime: baseRuntime,
      pageRevisionRuntime: runtimeOverride ?? new PiAgentRuntime(),
      codexCatalog,
      sandbox,
      memory,
      memoryProviders,
      home,
      artifacts,
      secretStore: secrets,
      secretHttp: remoteConnectors,
      pluginMarketplaceRead,
      pluginRepoFetcher,
      notifications,
      jobs,
      events,
      onTicketChange: ticketChanges,
      email: botEmail,
      // Single-process mode answers the job here; otherwise the worker does.
      lifecycleEmail:
        email && lifecycleEmailKinds.length > 0
          ? createLifecycleEmailSender({
              kinds: lifecycleEmailKinds,
              prisma,
              email,
              jobs,
              analytics,
            })
          : undefined,
      messaging,
      isMessagingInstallationActive: messagingInstallations
        ? (id: string) => messagingInstallations.isActive(id)
        : undefined,
      cloudAgent,
      userDevices: botUserDevices,
      paymentWallet,
      web,
      browser,
      stoppingSignal: shutdown.signal,
      shutdownSignal: runDrain.signal,
      now,
    });

  if (inMemoryJobs) {
    await inMemoryJobs.start(jobHandlers);
  }
  runs?.attach(jobHandlers);
  const reconciler = inMemoryJobs
    ? createRunReconciler(
        {
          prisma,
          secretStore: secrets,
          jobs,
          events,
          notifications,
          cloudAgent,
          userCloudAgents,
          paymentWallet,
          mediaGeneration,
          billingEnabled: modelCreditsEnabled,
        },
        {},
        { messagingDelivery, teamChat },
      )
    : undefined;
  reconciler?.start();
  const stopReferralEmails =
    email && billing?.referralsEnabled && emailCopyAvailable("referral")
      ? startHourlySweep(
          sendReferralEmails({
            prisma,
            email,
            appUrl: new URL("/app", env.webOrigin).href,
            origin: env.authUrl,
            secret: env.authSecret,
            onError: onEmailError,
          }),
          onEmailError,
        )
      : undefined;

  // Self-hosted deployments without billing keep every saved home.
  const stopHomeRetention =
    email && billingProvider && home instanceof ObjectAgentHomeStore
      ? startHourlySweep(
          homeRetentionSweep({
            prisma,
            email,
            appUrl: new URL("/app", env.webOrigin).href,
            onError: (error) => getLogger().error("saved home retention failed", error),
          }),
          (error) => getLogger().error("saved home retention failed", error),
        )
      : undefined;

  const stopOrganizationDeletions = startHourlySweep(
    finishStalledOrganizationDeletions({ ...spaceDeletionDeps, billing }),
    (error) => getLogger().error("stalled organization deletion failed", error),
  );

  // Meeting requests use a runtime with no persistent session recording.
  const meetingRuntime = new PiAgentRuntime();
  const meetingMedia =
    meetingMediaConfig &&
    meetingProvider &&
    (await import("./meetings/media/app-meeting-media.js")).appMeetingMedia({
      prisma,
      secrets,
      env,
      runtime: meetingRuntime,
      resolveModel: executor.resolveModel,
      config: meetingMediaConfig,
      billingEnabled: modelCreditsEnabled,
      providerId: meetingProvider.describe().id,
      enabled: (spaceId) => meetings.enabled(spaceId),
    });

  const router = createRouter({
    // Only computers people paired: nothing clears a routine's "Use my computer" when this
    // server's own screen is turned off and on again.
    userDevices: userDevicesOverride ?? userDevices,
    pageRevisions,
    meetings,
    meetingCalendar,
    meetingAnswers: createMeetingAnswers({
      prisma,
      runtime: meetingRuntime,
      resolveModel: executor.resolveModel,
      offline: meetingProvider?.describe().capabilities.offline === true,
      billingEnabled: modelCreditsEnabled,
    }),
    speechSummary:
      env.voiceSummaryMinChars === undefined
        ? undefined
        : {
            minChars: env.voiceSummaryMinChars,
            summarize: createSpeechSummarizer({
              prisma,
              runtime,
              resolveModel: executor.resolveModel,
            }),
          },
    analytics,
    pluginRepoFetcher,
    pluginMarketplaceRead,
    cloudAgent,
    userCloudAgents,
    paymentWallet,
    codexCatalog,
    prisma,
    notifications,
    pushTokens,
    workActivities,
    events,
    ticketChanges,
    boardEvents,
    auth,
    jobs,
    sandbox,
    memory,
    memoryProviders,
    home,
    secrets,
    oauthLogins,
    integrationSettings,
    mcpOAuth,
    mcp,
    connectors: stack.connector,
    remoteConnectors,
    modelConnectionFetch,
    // The scripted runtime never calls a provider, so neither does its connect.
    modelConnectionCheck: env.agentRuntime === "pi" ? verifyModelServesAgents : undefined,
    artifacts,
    email,
    onEmailError,
    dataDir: env.dataDir,
    billing,
    messagingInstallations,
    messagingDelivery,
    messaging: {
      enabled: Boolean(messaging),
      providers: messaging?.platforms().map((platform) => platform.provider) ?? [],
      get addresses() {
        return messagingAddresses(messaging?.platforms() ?? []);
      },
      resolveAddresses: messaging?.resolveAddresses?.bind(messaging),
      openSignup: env.messagingOpenSignup,
    },
    env: routerEnv(env),
  });
  const app = new Hono();
  app.onError(handleHttpError);
  const inFlight = trackInFlightRequests();
  app.use("*", inFlight.middleware);
  app.use("*", requestLogging(logger));
  app.use("*", clientIpMiddleware(clientIp, env.clientIpHeader));
  app.use(
    "*",
    cors({
      origin: (origin, c) => {
        // Anyone may submit a plugin from any site; the endpoint reads no cookies.
        if (c.req.path === PLUGIN_SUBMISSIONS_PATH) return "*";
        if (!origin) return env.webOrigin;
        return isTrustedOrigin(origin, env) ? origin : "";
      },
      credentials: true,
      exposeHeaders: [SERVER_BUILD_HEADER, "x-voice-id"],
    }),
  );
  const { readSession, sendRenewedCookies, requestSession, sessionActor } = requestSessions({
    auth,
    prisma,
  });
  app.use("*", sendRenewedCookies);
  // Session and account replies must never be stored by a client or an HTTP cache.
  for (const path of ["/api/auth/*", "/rpc/*"]) {
    app.use(path, async (c, next) => {
      await next();
      c.header("cache-control", "no-store");
    });
  }
  mountAuthCapabilities(app, { env, auth, email, billing });
  mountAppAssociation(app, env);
  if (localEmailEmulator && env.nodeEnv === "development") {
    app.get(
      "/api/dev/emails",
      () =>
        new Response(JSON.stringify(localEmailEmulator.sent), {
          headers: { "cache-control": "no-store", "content-type": "application/json" },
        }),
    );
  }
  app.route(
    "/",
    monitoringRoutes(
      env.browserMonitoring,
      fetch,
      async (request) => (await readSession(request))?.user.id,
    ),
  );
  app.route("/", cspReportRoutes(requestClientIp));
  app.route(
    "/",
    pluginSubmissionRoutes({
      prisma,
      email,
      adminEmails: env.adminEmails,
      webOrigin: env.webOrigin,
      clientIp: requestClientIp,
      onEmailError,
    }),
  );
  app.route("/", marketingEmailRoutes(prisma, env.authSecret));
  mountApiRequestBodyLimits(app);
  mountScreenTarget(app, prisma, env.screenProxySecret);
  mountScriptAssets(app);
  mountSharedPages(app, prisma, requestClientIp);
  const auditAuthResponse = createAuthResponseAudit();
  for (const [path, reason] of SYSTEM_CONTEXT_PATHS) {
    app.use(path, (_c, next) => runAsSystem(reason, next));
  }
  directory?.mount(app, {
    prisma,
    pushTokens,
    devices: deviceSessions,
    events,
    meetingCalendar,
    afterDeparture: (actor, departure) =>
      afterSpaceDeparture(
        { prisma, sandbox, jobs, events, meetings, meetingCalendar },
        actor,
        departure,
      ),
  });
  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    const path = new URL(c.req.url).pathname.replace("/api/auth", "");
    if (isBlockedAuthPath(path)) {
      return c.json({ error: "Not available in version 1" }, 404);
    }
    const ip = requestClientIp(c);
    const response = await withAuthLibraryFailures(() =>
      auth.handler(withClientIp(emptyAuthBodyAsJson(c.req.raw), ip)),
    );
    await auditAuthResponse(path, ip, response);
    return response;
  });
  mountLocalComputerHost(app, {
    token: env.desktopStackToken,
    sandboxProvider: env.sandboxProvider,
    prisma,
  });
  if (userDeviceHub && userDevices) {
    mountUserDeviceRoutes(app, {
      prisma,
      hub: userDeviceHub,
      devices: userDevices,
      forwardSecret: userDeviceSecret,
      pairingSecret: createHmac("sha256", env.encryptionKey)
        .update("rakazo:user-device-pair:v1")
        .digest("hex"),
      session: async (request) => {
        const found = await readSession(request);
        return found ? { userId: found.user.id, sessionId: found.session.id } : null;
      },
      trustedOrigin: (origin) => isTrustedOrigin(origin, env),
    });
  }
  if (messagingInstallations) {
    // Slack's registered redirect; the signed-in app finishes it so only the installer can.
    app.get("/api/v1/messaging/install/slack/callback", (c) => {
      const target = new URL("/messaging/slack/callback", env.webOrigin);
      target.search = new URL(c.req.url).search;
      return c.redirect(target.toString());
    });
  }
  mountRpcRoute(app, router, requestSession, env);
  mountAccountExportRoute(app, { prisma, auth, artifacts, home });
  mountAuditExportRoute(app, { prisma, sessionActor });
  mountVoiceHttpRoutes(app, { prisma, secrets, env }, (c) => sessionActor(c.req.raw));
  mountAccountImportRoute(
    app,
    { ...spaceDeletionDeps, maxArtifactBytes: env.maxUploadSizeBytes },
    sessionActor,
  );
  if (meetingProvider) mountMeetingWebhook(app, meetings);
  meetingMedia?.mount(app);
  if (meetingCalendar) mountMeetingCalendarHttp(app, meetingCalendar, sessionActor);
  const linkSchemes = ["https", ...T3CODE_LINK_SCHEMES];
  mountWebhookHttpRoutes(app, { prisma, secrets, events, jobs, notifications, linkSchemes });
  if (env.inboundEmail) {
    mountEmailInboundRoute(app, {
      prisma,
      events,
      jobs,
      ...env.inboundEmail,
      storeAttachment: ({ spaceId, userId, ...input }) =>
        storeInboundAttachment(
          { prisma, artifacts, maxUploadSizeBytes: env.maxUploadSizeBytes },
          { spaceId, userId },
          input,
        ),
    });
  }
  if (billing && billingProvider) {
    mountBillingRoutes(app, {
      billing,
      provider: billingProvider,
      webOrigin: env.webOrigin,
      authenticate: sessionActor,
    });
  }
  const messagingRuntime =
    messaging && messagingDelivery && teamChat
      ? await startMessagingRuntime({
          app,
          prisma,
          events,
          jobs,
          sandbox,
          secrets,
          artifacts,
          env,
          messaging,
          messagingInstallations,
          delivery: messagingDelivery,
          teamChat,
        })
      : undefined;

  app.route(
    "/",
    healthRoutes(
      () => ({
        runtime: env.agentRuntime,
        sandbox: env.sandboxProvider,
        integrations: [stack.composio, pipedream].flatMap((provider) =>
          provider ? [provider.describe().id] : [],
        ),
        messaging: Boolean(messaging),
        email: email?.describe().id ?? null,
        billing: billingProvider?.describe().id ?? null,
        jobs: jobKind,
        realtime: realtime.describe().id,
        secrets: secrets.describe(),
        degraded: secrets.describe().capabilities.degraded ?? false,
        revision: env.gitSha ?? null,
      }),
      databaseProbe(prisma),
    ),
  );

  let stopped: Promise<void> | undefined;
  return {
    app,
    prisma,
    jobs,
    sandbox,
    composio: stack.composio,
    connectors: stack.connector,
    messaging,
    email,
    notifications,
    executor,
    runtime,
    awaitIdle: inMemoryJobs ? () => inMemoryJobs.awaitIdle() : undefined,
    backgroundFailures: inMemoryJobs ? () => inMemoryJobs.failureCounts() : undefined,
    handleUpgrade: userDeviceHub?.handleUpgrade,
    stop: (options = {}) => {
      if (!options.letRunsFinish) runDrain.end();
      stopped ??= (async () => {
        // Abort in-flight continueRun boot waits before draining jobs so stop() cannot sit
        // on waitForComputerReady for the full boot-wait window during shared Postgres journeys.
        // It also ends run claims at once, while ordinary requests still finish.
        shutdown.abort();
        // Aborted runs hand themselves back while realtime is still open to announce them.
        const runsStopped = runs?.stop();
        // The next release polls for chat messages now; replies from turns still running send.
        await messagingRuntime?.stopReceiving();
        await options.connectionsClosed;
        // Handlers still running would otherwise query the pool after it ends.
        const requestsSettled = settleWithTimeout(inFlight.settled(), REQUEST_DRAIN_MS);
        auth.disposeOidcDiscovery();
        await userDeviceHub?.close();
        await oauthLogins.abortAll();
        await stopReferralEmails?.();
        await stopHomeRetention?.();
        await stopOrganizationDeletions();
        await reconciler?.stop();
        await oauthTokenUpgrade;
        await mcpArgsMove;
        await runsStopped;
        await messagingRuntime?.stop();
        await requestsSettled;
        await botEmail?.drain?.();
        await email?.drain?.();
        await closeServerFoundation(foundation, { jobs, connectors });
        await bestEffort("close database pool", created.pool?.end());
        await bestEffort("close job database pool", ownedJobPool?.end());
        await analytics?.flush();
        await logger.flush({ timeoutMs: 2_000 });
      })();
      return stopped;
    },
  };
}
