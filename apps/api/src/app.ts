import { hostname } from "node:os";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type {
  AgentContextStrategy,
  AgentRuntime,
  BillingProvider,
  ConnectorProvider,
  JobPublisher,
  ManagedConnectorProvider,
  MessagingInboundEvent,
  MessagingSurface,
  NotificationProvider,
  RealtimeFanout,
  SandboxProvider,
  TransactionalEmailProvider,
} from "@rakazo/adapter-kit";
import {
  SandboxDamagedError,
  SandboxRateLimitError,
  SandboxUnavailableError,
  SandboxUnresponsiveError,
  VoiceAccountError,
} from "@rakazo/adapter-kit";
import type {
  ComposioProvider,
  ConnectorRegistry,
  PluginRepoFetcher,
  PluginTextReader,
  RemoteConnectorDependencies,
  UserDeviceGateway,
} from "@rakazo/adapters";
import {
  applyMessagingOutboundStatus,
  ChatSdkMessagingSurface,
  CodexCatalogCache,
  ComposioConnector,
  contentKeyProviderFromEnv,
  createAgentHomeStore,
  createArtifactStore,
  createBackgroundJobHandlers,
  createCloudAgentConnection,
  createConnectorStack,
  createIdleComputerSweeper,
  createJobReconciler,
  createMessagingContextLoader,
  createMessagingTeamChatHistory,
  createMessagingTeamChatSender,
  createModelCreditReconciler,
  createPaymentWalletProvider,
  createProductAnalytics,
  createRunExecutor,
  createRunSandbox,
  createRunSecretWriter,
  createSecretStore,
  createTicketChangeNotifier,
  createWebProvider,
  deploymentModelUsageLookup,
  EmailEmulator,
  ExpoPushProvider,
  GraphileJobPublisher,
  InMemoryJobQueue,
  InMemoryRealtimeFanout,
  InstalledConnectorProvider,
  IntegrationProviderSettings,
  installedMessaging,
  isComposioEnabled,
  isMessagingSurfaceEnabled,
  isPipedreamEnabled,
  McpConnector,
  McpOAuthBroker,
  messagingPlatformsFromEnv,
  PiAgentRuntime,
  PiOAuthLogins,
  PipedreamConnector,
  PostgresRealtimeFanout,
  PrismaPushTokenStore,
  pipedreamConfigFromEnv,
  piSessionsRoot,
  RunJobPublisher,
  RunStarter,
  reconcileCloudAgents,
  reconcileComputerUpdates,
  reconcilePurchases,
  removePiUserSessions,
  resolveDeploymentModel,
  ScriptedAgentRuntime,
  SpaceMemoryProviderResolver,
  StripeBillingProvider,
  sandboxProviderOptionsFromEnv,
  stripeBillingConfigFromEnv,
  toTeamChatInbound,
  UserDeviceHub,
  UserDevices,
  userDeviceForwardSecret,
  userDeviceInternalAddress,
  verifyModelServesAgents,
  withSecretPersistence,
} from "@rakazo/adapters";
import { createAuth, isBlockedAuthPath, loopbackTwinOrigins } from "@rakazo/auth";
import type { Actor, AuthCapabilities } from "@rakazo/contracts";
import {
  isLocalhostOrLoopbackIp,
  PLUGIN_SUBMISSIONS_PATH,
  SERVER_BUILD_HEADER,
} from "@rakazo/contracts";
import { encryptionKeyWarning, signupPolicyFromEnv } from "@rakazo/core";
import type { Pool, PrismaClient } from "@rakazo/db";
import {
  createBoardEvents,
  createDb,
  createPool,
  createSecurityEventPruner,
  createThreadEvents,
  describeRowSecurity,
  IsolationError,
  installSecurityEventStore,
  ProviderTransactionBusyError,
  parsePositiveInteger,
  provisionMessagingIdentity,
  pushSessionExpiresAt,
  requireMembership,
  rowSecurityWarning,
  runAsSystem,
  securityEventRetentionDays,
  verifyContentKeys,
} from "@rakazo/db";
import type { Logger } from "@rakazo/logging";
import {
  createServiceLogger,
  enrichLogContext,
  getLogger,
  installLogger,
  SERVICE_NAMES,
} from "@rakazo/logging";
import { requestLogging } from "@rakazo/logging/hono";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { deleteAccountContent } from "./account-deletion.js";
import { mountAccountExportRoute } from "./account-export.js";
import { mountAccountImportRoute } from "./account-import.js";
import { mountAppAssociation, nativePasskeys } from "./app-association.js";
import { storeInboundAttachment } from "./artifacts.js";
import { createBillingService } from "./billing.js";
import { mountBillingRoutes } from "./billing-webhook.js";
import { clientBuildMiddleware, readDeployedWebBuild } from "./client-build.js";
import {
  clientIpMiddleware,
  createClientIpResolver,
  defaultTrustedProxies,
  requestClientIp,
  withClientIp,
} from "./client-ip.js";
import { cspReportRoutes } from "./csp-report.js";
import { mountDiagramScript } from "./diagram-script.js";
import { configuredEmailProvider } from "./email.js";
import type { AppEnv } from "./env.js";
import { loadEnv } from "./env.js";
import { healthRoutes } from "./health.js";
import { mountLocalComputerHost } from "./local-settings.js";
import { marketingEmailRoutes, sendWelcomeEmail } from "./marketing-email.js";
import { moveMcpArgsIntoSecrets } from "./mcp-args-migration.js";
import {
  createMessagingInboundHandler,
  teamChatSenderCanWakeMessageRoutines,
  wakeMessageRoutines,
} from "./messaging-inbound.js";
import { createMessagingReceipts } from "./messaging-receipts.js";
import { mountMessagingWebhookRoutes } from "./messaging-webhook.js";
import { monitoringRoutes } from "./monitoring.js";
import { pluginSubmissionRoutes } from "./plugin-submissions.js";
import { sendReferralEmails, startReferralEmails } from "./referral-email.js";
import { mountApiRequestBodyLimits } from "./request-body-limit.js";
import { createRouter } from "./router.js";
import { mountScreenTarget } from "./screen-proxy.js";
import { createAuthResponseAudit } from "./security-audit.js";
import { createSpeechSummarizer } from "./speech-summary.js";
import { isDeferredReservationLost, TeamChatBridge } from "./team-chat-bridge.js";
import { ModelTeamChatEngagementJudge } from "./team-chat-judge.js";
import {
  PendingTeamChatInbound,
  prefersTeamChatSurface,
  settleWithTimeout,
  TEAM_CHAT_STARTUP_SHUTDOWN_MS,
  TeamChatStartupRetries,
} from "./team-chat-startup.js";
import { mountUserDeviceRoutes } from "./user-devices.js";
import { mountVoiceHttpRoutes, voiceAccountErrorStatus } from "./voice.js";
import { mountWebhookHttpRoutes } from "./webhook.js";

/**
 * Native clients always send the app scheme, including in Expo Go, so no
 * exp:// origin is trusted: it would accept any Expo host as a redirect target.
 * The loopback entries are the Expo web dev server.
 */
export const MOBILE_AUTH_ORIGINS = [
  "rakazo://",
  "http://localhost:8081",
  "http://127.0.0.1:8081",
  "http://localhost:19006",
  "http://127.0.0.1:19006",
];

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
  stop: () => Promise<void>;
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
    ...envOverrides
  } = overrides;
  const env = { ...loadEnv(process.env), ...envOverrides };
  const logger = loggerOverride ?? createServiceLogger({ service: SERVICE_NAMES.api });
  installLogger(logger);
  const created = prismaOverride
    ? { prisma: prismaOverride, pool: undefined }
    : createDb(env.databaseUrl, {
        poolMax: parsePositiveInteger(process.env.DB_POOL_MAX, 4),
        applicationName: "rakazo-api",
        keyProvider: contentKeyProviderFromEnv(),
        encryptContent: env.contentEncryption,
      });
  let { prisma } = created;
  // Built before anything listens, so a bad TRUSTED_PROXIES entry stops startup.
  const clientIp = createClientIpResolver({
    // Unset trusts the proxies a stack is built with: on loopback or on the API's own networks.
    // Trusting none would make the web proxy every client, one sign-in rate-limit bucket for all.
    trustedProxies: env.trustedProxies.length > 0 ? env.trustedProxies : defaultTrustedProxies(),
    header: env.clientIpHeader,
  });
  const rowSecurity = rowSecurityWarning(await describeRowSecurity(prisma));
  if (rowSecurity) logger.warn(rowSecurity);
  const weakEncryptionKey = encryptionKeyWarning(process.env);
  if (weakEncryptionKey) logger.warn(weakEncryptionKey);
  const realtime =
    realtimeOverride ??
    (created.pool
      ? new PostgresRealtimeFanout({
          connectionString: env.realtimeDatabaseUrl,
          publisher: created.pool,
        })
      : new InMemoryRealtimeFanout());
  const secrets = createSecretStore(env.encryptionKey, process.env, realtime);
  await secrets.start();
  if (secrets.describe().capabilities.degraded)
    logger.warn("Secret storage degraded; encrypted credentials remain available");
  prisma = withSecretPersistence(prisma, secrets);
  installSecurityEventStore(prisma);
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
  const ticketBoardEnabled = env.ticketBoardEnabled;
  const boardEvents = createBoardEvents(realtime);
  const environmentSignupPolicy = signupPolicyFromEnv(env);
  // Mirror the env policy for the previous release during a rolling deploy.
  await prisma.deploymentSettings.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      signupsEnabled: environmentSignupPolicy.enabled,
      signupAllowlist: environmentSignupPolicy.allowlist.join(","),
      signupPolicyInitialized: true,
    },
    update: {
      signupsEnabled: environmentSignupPolicy.enabled,
      signupAllowlist: environmentSignupPolicy.allowlist.join(","),
      signupPolicyInitialized: true,
    },
  });

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
  const ticketChanges = createTicketChangeNotifier({
    boardEvents,
    jobs,
    prisma,
    ticketBoardEnabled,
  });
  const sandbox: SandboxProvider =
    sandboxOverride ??
    (await createRunSandbox(env.sandboxProvider, {
      ...sandboxProviderOptionsFromEnv(),
      supervisorUrl: env.sandboxSupervisorUrl,
      supervisorToken: env.sandboxSupervisorToken,
      e2bApiKey: env.e2bApiKey,
      novitaApiKey: env.novitaApiKey,
      sandboxTemplate: env.sandboxTemplate,
      daytonaApiKey: env.daytonaApiKey,
      daytonaApiUrl: env.daytonaApiUrl,
      daytonaTarget: env.daytonaTarget,
      boatApiKey: env.boatApiKey,
      boatApiUrl: env.boatApiUrl,
      dataDir: env.dataDir,
      prisma,
    }));
  const mcpOAuth = new McpOAuthBroker(
    prisma,
    secrets,
    remoteConnectors,
    env.mcpAllowPrivateEndpoint,
  );
  const memoryProviders = new SpaceMemoryProviderResolver(prisma, secrets);
  const oauthLogins = new PiOAuthLogins(undefined, { prisma, secrets });
  const home = createAgentHomeStore(env.dataDir, prisma);
  void home.removeStaleStaging().catch((error) => getLogger().error("home staging cleanup", error));
  const artifacts = createArtifactStore(env.dataDir, prisma);
  const memory = new MarkdownMemoryStore(prisma);
  const mcp = new McpConnector(
    prisma,
    secrets,
    {
      stdioEnabled: env.mcpStdioEnabled,
      allowedCommands: env.mcpStdioAllowedCommands,
      ...env.mcpStdio,
      network: remoteConnectors,
      events,
      allowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
    },
    mcpOAuth,
  );
  const pipedreamConfig = pipedreamConfigFromEnv(env);
  const pipedream =
    pipedreamOverride ??
    (isPipedreamEnabled(pipedreamConfig) ? new PipedreamConnector(pipedreamConfig) : undefined);
  // This process registers the inbound sink, so it must hold Telegram's getUpdates connection.
  const messagingPlatforms = messagingPlatformsFromEnv(env, { pollInboundMessages: true }).filter(
    (platform) => platform.provider !== "slack" || !env.slackClientId,
  );
  const legacyMessaging =
    messagingOverride ??
    (isMessagingSurfaceEnabled(messagingPlatforms, {
      deploymentModelConfigured: env.deploymentModelConfigured,
      openSignup: env.messagingOpenSignup,
    })
      ? new ChatSdkMessagingSurface(messagingPlatforms)
      : undefined);
  const { messaging, installations: messagingInstallations } = messagingOverride
    ? { messaging: messagingOverride, installations: undefined }
    : installedMessaging(prisma, secrets, env, legacyMessaging, jobs);
  const configuredEmail = emailOverride ?? configuredEmailProvider(env);
  const localEmailEmulator =
    !configuredEmail && env.emailEmulator
      ? new EmailEmulator((message) => {
          getLogger().info("email emulator captured message", {
            "email.subject": message.subject,
          });
        })
      : undefined;
  if (localEmailEmulator && !isLocalhostOrLoopbackIp(env.apiHost)) {
    throw new Error("EMAIL_EMULATOR requires API_HOST to be a loopback host");
  }
  const email: TransactionalEmailProvider | undefined = configuredEmail ?? localEmailEmulator;
  const onEmailError = (error: unknown) =>
    getLogger().error("transactional email delivery failed", error);
  const stripeBilling = stripeBillingConfigFromEnv(env);
  const billingProvider: BillingProvider | undefined =
    billingOverride ?? (stripeBilling ? new StripeBillingProvider(stripeBilling) : undefined);
  const billing = billingProvider
    ? createBillingService({
        prisma,
        provider: billingProvider,
        webOrigin: env.webOrigin,
        managedModelsAvailable: resolveDeploymentModel().configured,
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
  const installed = new InstalledConnectorProvider(
    prisma,
    secrets,
    remoteConnectors,
    env.mcpAllowPrivateEndpoint,
  );
  const integrationSettings = new IntegrationProviderSettings(prisma, secrets, env.encryptionKey, {
    composio:
      composioOverride ??
      (isComposioEnabled(env.composioApiKey)
        ? new ComposioConnector({ apiKey: env.composioApiKey })
        : undefined),
    pipedream,
  });
  const stack = createConnectorStack(composioOverride, [
    installed,
    ...integrationSettings
      .providers()
      .filter((provider) => !composioOverride || provider.describe().id !== "composio"),
    mcp,
    ...connectorOverrides,
  ]);
  integrationSettings.warmDirectories();
  const runtime =
    runtimeOverride ??
    (env.agentRuntime === "scripted"
      ? new ScriptedAgentRuntime()
      : new PiAgentRuntime({
          sessionRoot: env.piSessionRecording ? piSessionsRoot(env.dataDir) : undefined,
        }));
  const pushTokens = new PrismaPushTokenStore(prisma, env.encryptionKey);
  const notifications =
    notificationsOverride ??
    new ExpoPushProvider(pushTokens, {
      sessionExpiresAt: (sessionId) => pushSessionExpiresAt(prisma, sessionId),
      jobs,
      accessToken: env.expoAccessToken,
    });
  const auth = createAuth(prisma, {
    analytics,
    passwordAuth: env.passwordAuth,
    breachedPasswordCheck: env.breachedPasswordCheck,
    oidc: env.oidc,
    secret: env.authSecret,
    baseURL: env.authUrl,
    webOrigin: env.webOrigin,
    signupsEnabled: env.signupsEnabled,
    signupAllowlist: env.signupAllowlist,
    email,
    logger: {
      level: "error",
      log: (_level, _message, ...args) =>
        getLogger().error(
          "auth.request.failed",
          args.find((arg) => arg instanceof Error),
        ),
    },
    onEmailError,
    afterSignIn:
      email && env.welcomeEmailEnabled
        ? (userId) =>
            sendWelcomeEmail(
              {
                prisma,
                email,
                origin: env.authUrl,
                secret: env.authSecret,
                onError: (error) => getLogger().error("welcome email delivery failed", error),
              },
              userId,
            )
        : undefined,
    extraOrigins: MOBILE_AUTH_ORIGINS,
    androidAppCertFingerprints: env.passkeyAndroidCertFingerprints,
    beforeDeleteUser: async (userId) => {
      // First, so a provider failure aborts deletion before anything is destroyed.
      await billing?.cancelForDeletedUser(userId);
      await deleteAccountContent(
        {
          prisma,
          sandbox,
          home,
          jobs,
          artifacts,
          dataDir: env.dataDir,
          messagingInstallations,
        },
        userId,
      );
      await removePiUserSessions(env.dataDir, userId);
      await pushTokens
        .remove(userId)
        .catch((error) => getLogger().error("push token removal failed", error));
    },
    // The session change already happened, so a registration cleanup failure must not fail sign-out.
    afterDeleteSession: async (session) => {
      await pushTokens
        .endSession(session.userId, session.id)
        .catch((error) => getLogger().error("push token removal failed", error));
    },
    afterReplaceSession: async (previous, session) => {
      await pushTokens
        .endSession(session.userId, previous.id, session.id)
        .catch((error) => getLogger().error("push token session update failed", error));
    },
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
  const userDeviceSecret = userDeviceForwardSecret(env.encryptionKey);
  const userDeviceHub = env.userDevicesEnabled
    ? new UserDeviceHub({ prisma, address: userDeviceInternalAddress(env.apiHost, env.port) })
    : undefined;
  const userDevices = userDeviceHub
    ? new UserDevices({ prisma, forwardSecret: userDeviceSecret, hub: userDeviceHub })
    : undefined;
  const executor = createRunExecutor({
    billingEnabled: modelCreditsEnabled,
    maxUploadSizeBytes: env.maxUploadSizeBytes,
    contextStrategy,
    prisma,
    runtime,
    codexCatalog,
    sandbox,
    memory,
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
      env.deploymentModelKey ?? "",
      env.composioApiKey ?? "",
      env.cursorApiKey ?? "",
      process.env.TYPESAFE_API_KEY ?? "",
    ].filter(Boolean),
    secretStore: secrets,
    secretHttp: remoteConnectors,
    mcpAllowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
    deploymentModelKey: env.deploymentModelKey,
    deploymentModelConfigured: env.deploymentModelConfigured,
    dataDir: env.dataDir,
    notifications,
    jobs,
    events,
    onTicketChange: ticketChanges,
    ticketBoardEnabled,
    phoneCallsEnabled: env.phoneCallsEnabled,
    phoneCallRingSeconds: env.phoneCallRingSeconds,
    phoneCallCooldownMinutes: env.phoneCallCooldownMinutes,
    messaging: messaging ? createMessagingContextLoader(prisma) : undefined,
    web: createWebProvider(),
    cloudAgent,
    userDevices: userDevicesOverride ?? userDevices,
    paymentWallet,
    shutdownSignal: shutdown.signal,
  });

  const jobHandlers = createBackgroundJobHandlers({
    executor,
    prisma,
    sandbox,
    home,
    artifacts,
    jobs,
    events,
    // Every API container runs node as the same pid, and deploys run old and new side by side.
    workerId: `${hostname()}:${process.pid}`,
    runtime,
    notifications: notifications instanceof ExpoPushProvider ? notifications : undefined,
    secretStore: secrets,
    memoryProviders,
    deploymentModelKey: env.deploymentModelKey,
    deploymentModelConfigured: env.deploymentModelConfigured,
    messaging,
    cloudAgent,
    paymentWallet,
  });
  if (inMemoryJobs) {
    await inMemoryJobs.start(jobHandlers);
  }
  runs?.attach(jobHandlers);
  const reconciler = inMemoryJobs
    ? createJobReconciler({
        prisma,
        jobs,
        events,
        notifications,
        reconcileModelCredits: createModelCreditReconciler({
          prisma,
          lookup: deploymentModelUsageLookup(),
        }),
        reconcileCloudAgents: () => reconcileCloudAgents({ prisma, jobs, cloudAgent }),
        reconcilePurchases: () => reconcilePurchases({ prisma, jobs, paymentWallet }),
        reconcileComputerUpdates: () => reconcileComputerUpdates({ prisma, jobs }),
        reconcileSecurityEventRetention: createSecurityEventPruner(
          prisma,
          securityEventRetentionDays(),
        ),
        reconcileIdleComputers: createIdleComputerSweeper({ prisma, jobs }),
      })
    : undefined;
  reconciler?.start();
  const stopReferralEmails =
    email && env.welcomeEmailEnabled && billing?.referralsEnabled
      ? startReferralEmails(
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

  const router = createRouter({
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
    paymentWallet,
    codexCatalog,
    prisma,
    pushTokens,
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
    composio: stack.composio,
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
    messaging: {
      enabled: Boolean(messaging),
      providers: messaging?.platforms().map((platform) => platform.provider) ?? [],
      addresses: Object.fromEntries(
        (messaging?.platforms() ?? []).flatMap((platform) =>
          platform.address ? [[platform.provider, platform.address]] : [],
        ),
      ),
      openSignup: env.messagingOpenSignup,
    },
    env: {
      phoneCallsEnabled: env.phoneCallsEnabled,
      phoneCallRingSeconds: env.phoneCallRingSeconds,
      ticketBoardEnabled,
      navLinks: env.navLinks,
      adminEmails: env.adminEmails,
      maxUploadSizeBytes: env.maxUploadSizeBytes,
      maxAttachmentsPerMessage: env.maxAttachmentsPerMessage,
      agentRuntime: env.agentRuntime,
      defaultProvider: env.defaultProvider,
      defaultModel: env.defaultModel,
      teamChatJudgeProvider: env.teamChatJudgeProvider,
      teamChatJudgeModel: env.teamChatJudgeModel,
      deploymentModelConfigured: env.deploymentModelConfigured,
      deploymentModelHostCredentials: env.deploymentModelHostCredentials,
      webOrigin: env.webOrigin,
      privacyPolicyUrl: env.privacyPolicyUrl,
      screenProxySecret: env.screenProxySecret,
      sandboxProvider: env.sandboxProvider,
      gitSha: env.gitSha,
      integrationsCatalogUrl: env.integrationsCatalogUrl,
      mcpAllowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
      desktopHostChoiceEnabled: Boolean(env.desktopStackToken),
      mcpStdioEnabled: env.mcpStdioEnabled,
      mcpStdioAllowedCommands: env.mcpStdioAllowedCommands,
    },
  });
  const rpc = new RPCHandler(router, {
    clientInterceptors: [onError((error, { path, signal }) => handleRpcError(error, path, signal))],
  });
  const app = new Hono();
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
      exposeHeaders: [SERVER_BUILD_HEADER],
    }),
  );
  // Session and account replies must never be stored by a client or an HTTP cache.
  for (const path of ["/api/auth/*", "/rpc/*"]) {
    app.use(path, async (c, next) => {
      await next();
      c.header("cache-control", "no-store");
    });
  }
  app.get("/api/auth/capabilities", (c) => {
    return c.json({
      sso: env.oidc
        ? { name: env.oidc.name, availability: auth.ssoAvailability() ?? "checking" }
        : null,
      passwordAuth: env.passwordAuth !== false,
      passwordReset: env.passwordAuth !== false && Boolean(email),
      resetUrl:
        env.passwordAuth !== false && email ? new URL("/reset-password", env.webOrigin).href : null,
      emailCode: auth.emailCodeSignIn,
      billing: Boolean(billing),
      passkeyRpId: auth.passkeyRpId,
      nativePasskeys: nativePasskeys(env, auth.passkeyRpId),
      crispWebsiteId: billing ? (env.crispWebsiteId ?? null) : null,
    } satisfies AuthCapabilities);
  });
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
      async (request) => (await auth.api.getSession({ headers: request.headers }))?.user.id,
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
  mountApiRequestBodyLimits(app, env.maxUploadSizeBytes);
  mountScreenTarget(app, prisma, env.screenProxySecret);
  mountDiagramScript(app);
  const auditAuthResponse = createAuthResponseAudit();
  // Account and session tables, signup bootstrap and account deletion span tenants;
  // webhooks authenticate a bot or provider, then resolve the tenant from it.
  for (const [path, reason] of [
    ["/api/auth/*", "authentication"],
    ["/api/v1/bots/*", "bot webhook"],
    ["/api/v1/messaging/*", "messaging webhook"],
    ["/api/v1/phone/*", "messaging webhook"],
  ] as const) {
    app.use(path, (_c, next) => runAsSystem(reason, next));
  }
  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    const path = new URL(c.req.url).pathname.replace("/api/auth", "");
    if (isBlockedAuthPath(path)) {
      return c.json({ error: "Not available in version 1" }, 404);
    }
    const ip = requestClientIp(c);
    const response = await auth.handler(withClientIp(emptyAuthBodyAsJson(c.req.raw), ip));
    await auditAuthResponse(path, ip, response);
    return response;
  });
  mountLocalComputerHost(app, {
    token: env.desktopStackToken,
    sandboxProvider: env.sandboxProvider,
    prisma,
  });
  const requestSession = async (request: Request) => {
    // The bearer plugin turns a signed `Authorization: Bearer` into the session cookie.
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return null;
    const actor = await actorFromMembership(
      requireMembership(prisma, session.user.id, request.headers.get("x-rakazo-space-id")),
    );
    return actor && { actor, sessionId: session.session.id };
  };
  const sessionActor = async (request: Request) => (await requestSession(request))?.actor ?? null;
  if (userDeviceHub && userDevices) {
    mountUserDeviceRoutes(app, {
      prisma,
      hub: userDeviceHub,
      devices: userDevices,
      forwardSecret: userDeviceSecret,
      sessionUserId: async (request) =>
        (await auth.api.getSession({ headers: request.headers }))?.user.id ?? null,
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
  app.use(
    "/rpc/*",
    clientBuildMiddleware({
      webBuild: readDeployedWebBuild(),
      minimums: env.minimumClientBuilds ?? {},
    }),
  );
  app.use("/rpc/*", async (c, next) => {
    const session = await requestSession(c.req.raw);
    const actor = session?.actor ?? null;
    if (actor) {
      enrichLogContext({ "user.id": actor.userId, "space.id": actor.spaceId });
    }
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: "/rpc",
      context: {
        actor,
        sessionId: session?.sessionId,
        signal: c.req.raw.signal,
        // Same user in the same space, so leaving the space also ends a stream.
        // A database failure rejects this check; only a missing membership is unauthorized.
        stillAuthorized: async () => {
          const current = await sessionActor(c.req.raw);
          return Boolean(
            actor && current?.userId === actor.userId && current.spaceId === actor.spaceId,
          );
        },
      },
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });
  mountAccountExportRoute(app, { prisma, auth, artifacts, home });
  mountVoiceHttpRoutes(app, { prisma, secrets, env }, async (c) => {
    const actor = await sessionActor(c.req.raw);
    if (actor) enrichLogContext({ "user.id": actor.userId, "space.id": actor.spaceId });
    return actor;
  });
  mountAccountImportRoute(
    app,
    {
      prisma,
      sandbox,
      home,
      jobs,
      artifacts,
      dataDir: env.dataDir,
      messagingInstallations,
      maxArtifactBytes: env.maxUploadSizeBytes,
    },
    sessionActor,
  );
  mountWebhookHttpRoutes(app, { prisma, secrets, events, jobs });
  if (billing && billingProvider) {
    mountBillingRoutes(app, {
      billing,
      provider: billingProvider,
      webOrigin: env.webOrigin,
      authenticate: sessionActor,
    });
  }
  // Shared with stop so a shutdown during retry delays does not restart polling.
  let messagingStopped = false;
  let stopInstalledBridges: (() => Promise<void>) | undefined;
  let clearMessagingRetryDelay: (() => void) | undefined;
  let messagingInitTask: Promise<void> | undefined;
  let clearTeamChatRetryDelay: (() => void) | undefined;
  let teamChatInitTask: Promise<void> | undefined;
  let teamChatBridge: TeamChatBridge | undefined;
  /** Constructed even before start() succeeds so stop() can cancel in-flight startup. */
  let teamChatBridgeInstance: TeamChatBridge | undefined;
  const pendingTeamChatInbound = new PendingTeamChatInbound();
  const receipts = messaging ? createMessagingReceipts(messaging) : undefined;
  if (messaging) {
    const inboundDeps = {
      prisma,
      events,
      jobs,
      provision: (request, policyEnv) => provisionMessagingIdentity(prisma, request, policyEnv),
      openSignup: env.messagingOpenSignup,
      signupPolicy: {
        signupsEnabled: env.signupsEnabled,
        signupAllowlist: env.signupAllowlist,
      },
      acknowledge: receipts?.acknowledge,
      storeAttachment: ({ spaceId, userId, ...input }) =>
        storeInboundAttachment(
          { prisma, artifacts, maxUploadSizeBytes: env.maxUploadSizeBytes },
          { spaceId, userId },
          input,
        ),
    } satisfies Parameters<typeof createMessagingInboundHandler>[0];
    const inbound = createMessagingInboundHandler(inboundDeps);
    const handleTeamChatInbound = async (
      bridge: TeamChatBridge,
      event: Parameters<typeof wakeMessageRoutines>[2],
    ) => {
      const mapped = toTeamChatInbound(event);
      if (!mapped) {
        await inbound(event);
        return;
      }
      const canWake = await teamChatSenderCanWakeMessageRoutines(inboundDeps, event);
      if (!canWake) {
        await bridge.receive(mapped);
        return;
      }

      // Persist a non-reconcilable row until routine routing owns or releases
      // the message, so the timer cannot start a second TeamChat run.
      const target = await bridge.receive(mapped, { queueAgent: false });
      if (!target.deferred) return;
      const leaseHeartbeat = await bridge.startDeferredReservationHeartbeat(
        target.externalMessageId,
      );
      let woken = false;
      bridge.markRoutineWakeInFlight(target.externalMessageId);
      try {
        const wakePromise = wakeMessageRoutines(inboundDeps, target, event, {
          // Must match TeamChatBridge ExternalConversation / recovery provider.
          deliveryProvider: bridge.providerId,
          externalMessageId: target.externalMessageId,
        });
        try {
          woken = await Promise.race([wakePromise, leaseHeartbeat.lost]);
        } catch (error) {
          if (isDeferredReservationLost(error)) {
            // Lease loss must not start a fallback agent beside an in-flight
            // wake: re-hold exclusive ownership while awaiting that wake, then
            // resolve from its settled result.
            let hold: { stop: () => void } | undefined;
            try {
              hold = await bridge.startDeferredReservationHeartbeat(target.externalMessageId);
            } catch {
              // Row already left deferred; wake CAS / resolve decide the winner.
            }
            try {
              try {
                woken = await wakePromise;
              } catch (wakeError) {
                const released = await bridge.resolveDeferredMessage(
                  target.externalMessageId,
                  "agent",
                  mapped.kind,
                );
                if (!released) {
                  throw new Error("Team chat deferred message ownership conflict", {
                    cause: wakeError,
                  });
                }
                await bridge.reconcileOnce();
                getLogger().error(
                  "team chat routine wake failed after deferred lease loss",
                  wakeError,
                );
                return;
              }
            } finally {
              hold?.stop();
            }
          } else {
            await bridge.resolveDeferredMessage(target.externalMessageId, "agent", mapped.kind);
            await bridge.reconcileOnce();
            throw error;
          }
        }
        const resolved = await bridge.resolveDeferredMessage(
          target.externalMessageId,
          woken ? "routine" : "agent",
          mapped.kind,
        );
        if (!resolved) {
          throw new Error("Team chat deferred message ownership conflict");
        }
        if (!woken) await bridge.reconcileOnce();
      } finally {
        bridge.clearRoutineWakeInFlight(target.externalMessageId);
        leaseHeartbeat.stop();
      }
    };
    const flushPendingTeamChatInbound = (bridge: TeamChatBridge) => {
      pendingTeamChatInbound.flush((event) => handleTeamChatInbound(bridge, event));
    };
    const makeTeamChatBridge = (
      botId: string,
      installation?: { id: string; workspaceId: string },
    ) => {
      const judge =
        env.teamChatJudgeProvider && env.teamChatJudgeModel
          ? new ModelTeamChatEngagementJudge({
              prisma,
              runtime,
              secrets,
              deploymentProvider: env.defaultProvider,
              deploymentModel: env.defaultModel,
              deploymentModelKey: env.deploymentModelKey,
              allowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
              providerOverride: env.teamChatJudgeProvider,
              modelOverride: env.teamChatJudgeModel,
            })
          : new ModelTeamChatEngagementJudge({
              prisma,
              runtime,
              secrets,
              deploymentProvider: env.defaultProvider,
              deploymentModel: env.defaultModel,
              deploymentModelKey: env.deploymentModelKey,
              allowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
            });
      const bridge = new TeamChatBridge({
        prisma,
        events,
        jobs,
        send: createMessagingTeamChatSender(messaging),
        fetchThreadHistory: createMessagingTeamChatHistory(messaging),
        storeAttachment: ({ spaceId, userId, ...input }) =>
          storeInboundAttachment(
            { prisma, artifacts, maxUploadSizeBytes: env.maxUploadSizeBytes },
            { spaceId, userId },
            input,
          ),
        providerId: "slack",
        botId,
        workspaceId: installation?.workspaceId,
        conversationPrefix: installation ? `slack~${installation.id}:` : undefined,
        onUnavailable: installation
          ? () => {
              installedBridges.delete(installation.id);
            }
          : undefined,
        isAvailable: installation
          ? async () => Boolean(await messagingInstallations?.isActive(installation.id))
          : undefined,
        judge,
        acknowledge: receipts?.acknowledge,
      });
      return bridge;
    };
    const installedBridges = new Map<
      string,
      { bridge: TeamChatBridge; pending: Promise<TeamChatBridge> }
    >();
    const installedRetries = new TeamChatStartupRetries((error) =>
      getLogger().error("installed team chat restore failed; retrying", error),
    );
    const retryInstalledBridge = (installation: {
      id: string;
      botId: string;
      workspaceId: string;
    }) => {
      installedRetries.schedule(installation.id, () =>
        runAsSystem("retry installed team chat", async () => {
          if (messagingStopped) return;
          const active = await messagingInstallations?.isActive(installation.id);
          if (!active || messagingStopped) return;
          await installedBridge(installation);
        }),
      );
    };
    const installedBridge = (installation: { id: string; botId: string; workspaceId: string }) => {
      const existing = installedBridges.get(installation.id);
      if (existing) return existing.pending;
      const bridge = makeTeamChatBridge(installation.botId, installation);
      const pending = bridge
        .start()
        .then(() => {
          installedRetries.succeeded(installation.id);
          return bridge;
        })
        .catch(async (error) => {
          installedBridges.delete(installation.id);
          await bridge.stop();
          retryInstalledBridge(installation);
          throw error;
        });
      installedBridges.set(installation.id, { bridge, pending });
      return pending;
    };
    if (messagingInstallations) {
      await Promise.all(
        (await messagingInstallations.targets()).map((installation) =>
          runAsSystem("resume installed team chat", () => installedBridge(installation)).catch(
            (error) => {
              getLogger().error("installed team chat could not resume", error);
            },
          ),
        ),
      );
    }
    stopInstalledBridges = async () => {
      installedRetries.stop();
      // Stop first so an in-flight start() is cancelled, then bound the wait
      // as the static bridge does.
      await Promise.all(
        [...installedBridges.values()].map(({ bridge, pending }) =>
          settleWithTimeout(
            bridge
              .stop()
              .catch(() => undefined)
              .then(() => pending.catch(() => undefined)),
            TEAM_CHAT_STARTUP_SHUTDOWN_MS,
          ),
        ),
      );
    };
    if (env.teamChatBotId) {
      const bridge = makeTeamChatBridge(env.teamChatBotId);
      teamChatBridgeInstance = bridge;
      try {
        await bridge.start();
        teamChatBridge = bridge;
      } catch (error) {
        getLogger().error("team chat bridge failed to start; retrying", error);
        teamChatInitTask = (async () => {
          let delayMs = 2_000;
          while (!messagingStopped) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, delayMs);
              clearTeamChatRetryDelay = () => {
                clearTimeout(timer);
                clearTeamChatRetryDelay = undefined;
                resolve();
              };
            });
            clearTeamChatRetryDelay = undefined;
            if (messagingStopped) return;
            try {
              await bridge.start();
              if (messagingStopped) {
                await bridge.stop();
                return;
              }
              teamChatBridge = bridge;
              flushPendingTeamChatInbound(bridge);
              return;
            } catch (retryError) {
              if (
                retryError instanceof Error &&
                retryError.message === "Team chat bridge start cancelled"
              ) {
                return;
              }
              getLogger().error("team chat bridge failed to start; retrying", retryError);
              delayMs = Math.min(delayMs * 5, 30_000);
            }
          }
        })();
      }
    }
    const handleInbound = async (event: MessagingInboundEvent) => {
      if (event.type !== "message") {
        await applyMessagingOutboundStatus(prisma, event);
        return;
      }
      if (event.installationBotId && !event.isDirect) {
        if (!event.installationId || !event.workspaceId) return;
        const installation = {
          id: event.installationId,
          botId: event.installationBotId,
          workspaceId: event.workspaceId,
        };
        await handleTeamChatInbound(await installedBridge(installation), event);
        return;
      }
      if (!event.installationBotId && prefersTeamChatSurface(event, env.teamChatBotId)) {
        const bridge = teamChatBridge;
        if (bridge) {
          await handleTeamChatInbound(bridge, event);
          return;
        }
        // Bridge is still starting (or retrying). Do not fall through to the
        // personal-line inbound path — that bypasses externalMessage ownership
        // and can wake routines for unlinked TeamChat senders.
        if (teamChatInitTask) {
          const pending = pendingTeamChatInbound.enqueue(event);
          if (!pending) {
            throw new Error("Team chat inbound buffer is full");
          }
          await pending;
          return;
        }
        throw new Error("Team chat bridge is unavailable");
      }
      await inbound(event);
    };
    messaging.onInbound((event) => runAsSystem("messaging inbound", () => handleInbound(event)));
    mountMessagingWebhookRoutes(app, { messaging });
    // Start polling adapters now rather than on the first webhook or send; a second poller
    // elsewhere would fight this one for Telegram's single getUpdates slot. Bounded retries
    // cover transient startup failures, otherwise polling-only bots stay dark.
    messagingInitTask = (async () => {
      const delayMs = [0, 2_000, 10_000];
      for (let attempt = 0; attempt < delayMs.length; attempt += 1) {
        if (messagingStopped) return;
        if (delayMs[attempt]! > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delayMs[attempt]);
            clearMessagingRetryDelay = () => {
              clearTimeout(timer);
              clearMessagingRetryDelay = undefined;
              resolve();
            };
          });
          clearMessagingRetryDelay = undefined;
        }
        if (messagingStopped) return;
        try {
          await messaging.initialize?.();
          return;
        } catch (error) {
          getLogger().error(
            attempt === delayMs.length - 1
              ? "messaging surface initialize failed"
              : "messaging surface initialize failed; retrying",
            error,
          );
        }
      }
    })();
  }

  app.route(
    "/",
    healthRoutes(
      () => ({
        runtime: env.agentRuntime,
        sandbox: env.sandboxProvider,
        composio: Boolean(stack.composio),
        pipedream: Boolean(pipedream),
        messaging: Boolean(messaging),
        email: email?.describe().id ?? null,
        billing: billingProvider?.describe().id ?? null,
        jobs: jobKind,
        realtime: realtime.describe().id,
        secrets: secrets.describe(),
        degraded: secrets.describe().capabilities.degraded ?? false,
        revision: env.gitSha ?? null,
      }),
      // The statement timeout ends a stuck probe on the server too, freeing its connection.
      () =>
        prisma.$transaction([
          prisma.$executeRaw`SET LOCAL statement_timeout = 1500`,
          prisma.$queryRaw`SELECT 1`,
        ]),
    ),
  );

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
    stop: async () => {
      // Abort in-flight continueRun boot waits before draining jobs so stop() cannot sit
      // on waitForComputerReady for the full boot-wait window during shared Postgres journeys.
      auth.disposeOidcDiscovery();
      shutdown.abort();
      // Aborted runs hand themselves back while realtime is still open to announce them.
      const runsStopped = runs?.stop();
      await userDeviceHub?.close();
      oauthLogins.abortAll();
      messagingStopped = true;
      clearMessagingRetryDelay?.();
      clearTeamChatRetryDelay?.();
      receipts?.stop();
      pendingTeamChatInbound.reject(new Error("Team chat bridge stopped before startup"));
      // Cancel in-flight start() before awaiting the retry task so stop() cannot
      // sit on DB/reconcile work that bridge.start() is still running.
      await settleWithTimeout(
        teamChatBridgeInstance ? teamChatBridgeInstance.stop().catch(() => undefined) : undefined,
        TEAM_CHAT_STARTUP_SHUTDOWN_MS,
      );
      await messagingInitTask?.catch(() => undefined);
      await settleWithTimeout(teamChatInitTask, TEAM_CHAT_STARTUP_SHUTDOWN_MS);
      await messaging?.shutdown?.();
      await teamChatBridge?.stop();
      await stopInstalledBridges?.();
      await stopReferralEmails?.();
      await email?.drain?.();
      await reconciler?.stop();
      await oauthTokenUpgrade;
      await mcpArgsMove;
      await runsStopped;
      await jobs.close();
      await secrets.close();
      await realtime.close();
      await mcp.close();
      await prisma.$disconnect().catch(() => undefined);
      await created.pool?.end().catch(() => undefined);
      await ownedJobPool?.end().catch(() => undefined);
      await analytics?.flush();
      await logger.flush({ timeoutMs: 2_000 });
    },
  };
}

export function isTrustedOrigin(
  origin: string,
  env: Pick<AppEnv, "webOrigin" | "apiUrl" | "authUrl">,
) {
  if (!origin) return true;
  if (origin.startsWith("rakazo://")) return true;
  const allowed = new Set(
    [env.webOrigin, env.apiUrl, env.authUrl, ...MOBILE_AUTH_ORIGINS].flatMap(originVariants),
  );
  return allowed.has(origin);
}

function originVariants(origin: string): string[] {
  if (!origin || origin === "rakazo://") return [];
  const variants = [origin, ...loopbackTwinOrigins(origin)];
  try {
    const url = new URL(origin);
    if (url.protocol === "http:" || url.protocol === "https:") {
      variants.push(url.origin);
    }
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      const v6 = new URL(origin);
      v6.hostname = "[::1]";
      variants.push(v6.origin);
    }
  } catch {
    return variants;
  }
  return variants;
}

/**
 * No membership is no actor, which the RPC layer answers as 401. A database
 * failure, including the deployment-settings lookup, must stay a server error
 * so a blip does not look like a rejected session.
 */
export async function actorFromMembership(membership: Promise<Actor>): Promise<Actor | null> {
  try {
    return await membership;
  } catch (error) {
    if (error instanceof IsolationError) return null;
    throw error;
  }
}

/**
 * Some clients POST auth actions with an empty body (older phone sign-out, the web deletion code);
 * Better Auth rejects that before the endpoint runs.
 */
function emptyAuthBodyAsJson(request: Request) {
  if (
    request.method !== "POST" ||
    request.headers.get("content-length") !== "0" ||
    request.headers.has("transfer-encoding")
  ) {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Request(request, { headers, body: "{}" });
}

/**
 * Non-ORPCError failures are flattened into an opaque "Internal server error", so this log is
 * the only record of what broke. The cause chain matters: undici and most SDKs report a bare
 * "fetch failed" and keep the host and errno one level down.
 */
export function handleRpcError(
  error: unknown,
  path: readonly string[],
  signal?: AbortSignal,
): void {
  // A missing or foreign resource is the caller's mistake (a stale client, a deleted bot),
  // not a server failure, so it is a warning rather than an error report.
  if (error instanceof IsolationError) {
    getLogger().warn(`rpc ${path.join("/")} not found`, { "error.stack": error.stack });
    throw new ORPCError("NOT_FOUND", { message: error.message, cause: error });
  }
  // The user's own voice account refused the request: theirs to fix.
  if (error instanceof VoiceAccountError) {
    getLogger().warn(`rpc ${path.join("/")} voice provider account rejected the request`, {
      reason: error.code ?? error.message,
    });
    throw new ORPCError(error.code ?? "FORBIDDEN", {
      status: voiceAccountErrorStatus(error.code),
      message: error.message,
      cause: error,
    });
  }
  // The computer provider did not start the computer in time, or could not be reached: an outage
  // on its side the user can retry, not a server failure.
  if (error instanceof SandboxUnavailableError || error instanceof SandboxUnresponsiveError) {
    const unavailable =
      error instanceof SandboxUnavailableError
        ? error
        : new SandboxUnavailableError({ cause: error });
    getLogger().warn(`rpc ${path.join("/")} computer unavailable`, {
      reason: unavailable.cause instanceof Error ? unavailable.cause.message : undefined,
    });
    throw new ORPCError("SERVICE_UNAVAILABLE", { message: unavailable.message, cause: error });
  }
  // A provider kept another transaction busy past the wait; nothing failed, so the caller retries.
  if (error instanceof ProviderTransactionBusyError) {
    getLogger().warn(`rpc ${path.join("/")} provider transaction busy`);
    throw new ORPCError("SERVICE_UNAVAILABLE", { message: error.message, cause: error });
  }
  if (error instanceof SandboxRateLimitError) {
    getLogger().warn(`rpc ${path.join("/")} computer rate limited`, {
      reason: error.cause instanceof Error ? error.cause.message : undefined,
    });
    throw new ORPCError("TOO_MANY_REQUESTS", { message: error.message, cause: error });
  }
  // A retry cannot fix a damaged computer; its message tells the user to Recover it.
  if (error instanceof SandboxDamagedError) {
    getLogger().warn(`rpc ${path.join("/")} computer damaged`);
    throw new ORPCError("CONFLICT", { message: error.message, cause: error });
  }
  // The client went away mid-request, so whatever failed next has no one waiting for it.
  if (signal?.aborted && !(error instanceof ORPCError)) {
    getLogger().warn(`rpc ${path.join("/")} client disconnected`, {
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  logUnexpectedRpcError(error, path);
}

export function logUnexpectedRpcError(error: unknown, path: readonly string[]): void {
  if (error instanceof ORPCError) return;
  const where = `rpc ${path.join("/")} failed`;
  getLogger().error(where, error);
}
