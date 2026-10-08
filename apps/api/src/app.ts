import { randomUUID } from "node:crypto";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type {
  AgentContextStrategy,
  AgentRuntime,
  BillingProvider,
  JobPublisher,
  ManagedConnectorProvider,
  MessagingSurface,
  RealtimeFanout,
  SandboxProvider,
  TransactionalEmailProvider,
} from "@rakazo/adapter-kit";
import type {
  ComposioProvider,
  ConnectorRegistry,
  DestinationEmulator,
  RemoteConnectorDependencies,
} from "@rakazo/adapters";
import {
  applyMessagingOutboundStatus,
  ChatSdkMessagingSurface,
  CodexCatalogCache,
  ComposioConnector,
  createBackgroundJobHandlers,
  createCloudAgentConnection,
  createConnectorStack,
  createJobReconciler,
  createMessagingContextLoader,
  createMessagingTeamChatSender,
  createRunExecutor,
  createRunSandbox,
  createRunSecretWriter,
  createSecretStore,
  createWebProvider,
  deletePushToken,
  destroyBot,
  EmailEmulator,
  ExpoPushProvider,
  endSessionPushToken,
  GraphileJobPublisher,
  InMemoryJobQueue,
  InMemoryRealtimeFanout,
  InstalledConnectorProvider,
  IntegrationProviderSettings,
  isComposioEnabled,
  isMessagingSurfaceEnabled,
  isPipedreamEnabled,
  LocalAgentHomeStore,
  LocalArtifactStore,
  McpConnector,
  McpOAuthBroker,
  messagingPlatformsFromEnv,
  PiAgentRuntime,
  PiOAuthLogins,
  PipedreamConnector,
  PostgresRealtimeFanout,
  pipedreamConfigFromEnv,
  piSessionsRoot,
  reconcileCloudAgents,
  reconcileComputerUpdates,
  removePiUserSessions,
  ScriptedAgentRuntime,
  SmtpEmailProvider,
  SpaceMemoryProviderResolver,
  StripeBillingProvider,
  sandboxProviderOptionsFromEnv,
  stripeBillingConfigFromEnv,
  toTeamChatInbound,
  withSecretPersistence,
} from "@rakazo/adapters";
import { createAuth, isBlockedAuthPath, loopbackTwinOrigins } from "@rakazo/auth";
import type { Actor, AuthCapabilities } from "@rakazo/contracts";
import { signupAllowlistBootUpdate, signupPolicyFromEnv } from "@rakazo/core";
import type { Pool, PrismaClient } from "@rakazo/db";
import {
  createDb,
  createPool,
  createThreadEvents,
  IsolationError,
  parsePositiveInteger,
  provisionMessagingIdentity,
  pushSessionExpiresAt,
  requireMembership,
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
import { createBillingService } from "./billing.js";
import { mountBillingRoutes } from "./billing-webhook.js";
import type { AppEnv } from "./env.js";
import { loadEnv } from "./env.js";
import { healthRoutes } from "./health.js";
import { mountLocalSettings } from "./local-settings.js";
import {
  createMessagingInboundHandler,
  teamChatSenderCanWakeMessageRoutines,
  wakeMessageRoutines,
} from "./messaging-inbound.js";
import { mountMessagingWebhookRoutes } from "./messaging-webhook.js";
import { mountApiRequestBodyLimits } from "./request-body-limit.js";
import { createRouter } from "./router.js";
import { mountScreenTarget } from "./screen-proxy.js";
import { isDeferredReservationLost, TeamChatBridge } from "./team-chat-bridge.js";
import { ModelTeamChatEngagementJudge } from "./team-chat-judge.js";
import {
  PendingTeamChatInbound,
  prefersTeamChatSurface,
  settleWithTimeout,
  TEAM_CHAT_STARTUP_SHUTDOWN_MS,
} from "./team-chat-startup.js";
import { mountVoiceHttpRoutes } from "./voice.js";
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
  connector: DestinationEmulator;
  composio?: ComposioProvider;
  connectors: ConnectorRegistry;
  messaging?: MessagingSurface;
  email?: TransactionalEmailProvider;
  executor: ReturnType<typeof createRunExecutor>;
  runtime: AgentRuntime;
  awaitIdle?: () => Promise<void>;
  backgroundFailures?: () => Array<{ name: string; count: number }>;
  stop: () => Promise<void>;
}

export async function createApp(
  overrides: Partial<AppEnv> & {
    prisma?: PrismaClient;
    realtime?: RealtimeFanout;
    sandbox?: SandboxProvider;
    composio?: ComposioProvider;
    pipedream?: ManagedConnectorProvider;
    messaging?: MessagingSurface;
    email?: TransactionalEmailProvider;
    billing?: BillingProvider;
    remoteConnectors?: RemoteConnectorDependencies;
    logger?: Logger;
    runtime?: AgentRuntime;
    contextStrategy?: AgentContextStrategy;
  } = {},
): Promise<AppHandles> {
  const {
    prisma: prismaOverride,
    realtime: realtimeOverride,
    sandbox: sandboxOverride,
    composio: composioOverride,
    pipedream: pipedreamOverride,
    messaging: messagingOverride,
    email: emailOverride,
    billing: billingOverride,
    remoteConnectors,
    logger: loggerOverride,
    runtime: runtimeOverride,
    contextStrategy,
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
      });
  let { prisma } = created;
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
  const events = createThreadEvents(prisma, realtime, {
    runSecretWriter: createRunSecretWriter(secrets),
  });
  const environmentSignupPolicy = signupPolicyFromEnv(env);
  const deploymentSettings = await prisma.deploymentSettings.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      signupsEnabled: environmentSignupPolicy.enabled,
      signupAllowlist: environmentSignupPolicy.allowlist.join(","),
      signupPolicyInitialized: true,
    },
    update: {},
  });
  if (!deploymentSettings.signupPolicyInitialized) {
    // Older versions created this row with schema defaults even though auth
    // still enforced the environment policy. Copy that effective policy once
    // so upgrades preserve behavior. Later starts reapply a non-empty
    // SIGNUP_ALLOWLIST; a blank value leaves the stored list alone.
    await prisma.deploymentSettings.updateMany({
      where: { id: "default", signupPolicyInitialized: false },
      data: {
        signupsEnabled: environmentSignupPolicy.enabled,
        signupAllowlist: environmentSignupPolicy.allowlist.join(","),
        signupPolicyInitialized: true,
      },
    });
  } else {
    const signupAllowlist = signupAllowlistBootUpdate(
      deploymentSettings.signupAllowlist,
      env.signupAllowlist,
      true,
    );
    if (signupAllowlist !== null) {
      await prisma.deploymentSettings.update({
        where: { id: "default" },
        data: { signupAllowlist },
      });
      logger.info("applied SIGNUP_ALLOWLIST from the environment");
    }
  }

  const jobKind = env.wakeupDriver;
  const inMemoryJobs = jobKind === "memory" ? new InMemoryJobQueue() : undefined;
  // prismaOverride skips createDb, so there is no shared pool. The previous
  // GraphileJobPublisher(databaseUrl) path opened its own connections; keep a
  // bounded pool for that override path instead of passing undefined.
  let ownedJobPool: Pool | undefined;
  if (!inMemoryJobs && !created.pool) {
    ownedJobPool = createPool(env.databaseUrl, {
      poolMax: parsePositiveInteger(process.env.DB_POOL_MAX, 4),
      applicationName: "rakazo-api-jobs",
    });
  }
  const jobPool = created.pool ?? ownedJobPool;
  const jobs = inMemoryJobs
    ? inMemoryJobs
    : new GraphileJobPublisher(
        jobPool ??
          (() => {
            throw new Error("Graphile job publisher requires a PostgreSQL pool");
          })(),
      );
  const sandbox: SandboxProvider =
    sandboxOverride ??
    createRunSandbox(env.sandboxProvider, {
      ...sandboxProviderOptionsFromEnv(),
      supervisorUrl: env.sandboxSupervisorUrl,
      supervisorToken: env.sandboxSupervisorToken,
      e2bApiKey: env.e2bApiKey,
      daytonaApiKey: env.daytonaApiKey,
      daytonaApiUrl: env.daytonaApiUrl,
      daytonaTarget: env.daytonaTarget,
      boxApiKey: env.boxApiKey,
      boxApiUrl: env.boxApiUrl,
      dataDir: env.dataDir,
      prisma,
    });
  const mcpOAuth = new McpOAuthBroker(
    prisma,
    secrets,
    remoteConnectors,
    env.mcpAllowPrivateEndpoint,
  );
  const memoryProviders = new SpaceMemoryProviderResolver(prisma, secrets);
  const oauthLogins = new PiOAuthLogins();
  const home = new LocalAgentHomeStore(env.dataDir);
  const artifacts = new LocalArtifactStore(env.dataDir);
  const memory = new MarkdownMemoryStore(prisma);
  const mcp = new McpConnector(
    prisma,
    secrets,
    {
      stdioEnabled: env.mcpStdioEnabled,
      allowedCommands: env.mcpStdioAllowedCommands,
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
  // This process registers the inbound sink (messaging.onInbound below),
  // so it's the one that must hold Telegram's live getUpdates connection —
  // see messagingPlatformsFromEnv's docstring for why a second poller
  // elsewhere (e.g. the worker) would actively break this.
  const messagingPlatforms = messagingPlatformsFromEnv(env, { pollInboundMessages: true });
  const messaging =
    messagingOverride ??
    (isMessagingSurfaceEnabled(messagingPlatforms, {
      deploymentModelKey: env.deploymentModelKey,
      openSignup: env.messagingOpenSignup,
    })
      ? new ChatSdkMessagingSurface(messagingPlatforms)
      : undefined);
  const localEmailEmulator =
    !emailOverride && !env.smtpUrl && env.emailEmulator
      ? new EmailEmulator((message) => {
          getLogger().info("email emulator captured message", {
            "email.subject": message.subject,
          });
        })
      : undefined;
  if (localEmailEmulator && !isLoopbackHost(env.apiHost)) {
    throw new Error("EMAIL_EMULATOR requires API_HOST to be a loopback host");
  }
  const email: TransactionalEmailProvider | undefined =
    emailOverride ??
    (env.smtpUrl
      ? new SmtpEmailProvider({ url: env.smtpUrl, from: env.emailFrom ?? "" })
      : localEmailEmulator);
  const stripeBilling = stripeBillingConfigFromEnv(env);
  const billingProvider: BillingProvider | undefined =
    billingOverride ?? (stripeBilling ? new StripeBillingProvider(stripeBilling) : undefined);
  const billing = billingProvider
    ? createBillingService({ prisma, provider: billingProvider, webOrigin: env.webOrigin })
    : undefined;
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
        ? new ComposioConnector(env.composioApiKey)
        : undefined),
    pipedream,
  });
  const stack = createConnectorStack(false, composioOverride, [
    installed,
    ...integrationSettings
      .providers()
      .filter((provider) => !composioOverride || provider.describe().id !== "composio"),
    mcp,
  ]);
  const connector = stack.destination;
  await connector.start();
  integrationSettings.warmDirectories();
  const runtime =
    runtimeOverride ??
    (env.agentRuntime === "scripted"
      ? new ScriptedAgentRuntime()
      : new PiAgentRuntime({
          sessionRoot: env.piSessionRecording ? piSessionsRoot(env.dataDir) : undefined,
        }));
  const notifications = new ExpoPushProvider(env.dataDir, (sessionId) =>
    pushSessionExpiresAt(prisma, sessionId),
  );
  const auth = createAuth(prisma, {
    passwordAuth: env.passwordAuth,
    oidc: env.oidc,
    secret: env.authSecret,
    baseURL: env.authUrl,
    webOrigin: env.webOrigin,
    signupsEnabled: env.signupsEnabled,
    signupAllowlist: env.signupAllowlist,
    email,
    onEmailError: (error) => getLogger().error("transactional email delivery failed", error),
    extraOrigins: MOBILE_AUTH_ORIGINS,
    beforeDeleteUser: async (userId) => {
      // First, so a provider failure aborts deletion before anything is destroyed.
      await billing?.cancelForDeletedUser(userId);
      const bots = await prisma.bot.findMany({
        where: { userId },
        select: { id: true, userId: true, spaceId: true, name: true, archivedAt: true },
      });
      await Promise.all(
        bots.map((bot) =>
          destroyBot(
            { prisma, sandbox, home, jobs, artifacts, dataDir: env.dataDir },
            bot,
            {
              operationId: `account-delete:${userId}`,
              traceId: `account-delete:${userId}`,
              spaceId: bot.spaceId,
              userId,
              botId: bot.id,
              signal: new AbortController().signal,
            },
            { deleteMemories: true },
          ),
        ),
      );
      await removePiUserSessions(env.dataDir, userId);
      await deletePushToken(env.dataDir, userId).catch((error) =>
        getLogger().error("push token removal failed", error),
      );
    },
    // The session change already happened, so a token file failure must not fail sign-out.
    afterDeleteSession: async (session) => {
      await endSessionPushToken(env.dataDir, session.userId, session.id).catch((error) =>
        getLogger().error("push token removal failed", error),
      );
    },
    afterReplaceSession: async (previous, session) => {
      await endSessionPushToken(env.dataDir, session.userId, previous.id, session.id).catch(
        (error) => getLogger().error("push token session update failed", error),
      );
    },
  });
  // One provider instance so emulator launches and polls share the same Map.
  const cloudAgent = createCloudAgentConnection({
    CLOUD_AGENT_PROVIDER: env.cloudAgentProvider,
    CURSOR_API_KEY: env.cursorApiKey,
    CLOUD_AGENT_SPACE_ID: env.cloudAgentSpaceId,
  });
  const shutdown = new AbortController();
  // One cache serves models.list, selection validation, and run-time model
  // resolution alike, so a list call warms the run path in this process.
  const codexCatalog = new CodexCatalogCache();
  const executor = createRunExecutor({
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
    dataDir: env.dataDir,
    notifications,
    jobs,
    events,
    messaging: messaging ? createMessagingContextLoader(prisma) : undefined,
    web: createWebProvider(),
    cloudAgent,
    shutdownSignal: shutdown.signal,
  });

  const jobHandlers = createBackgroundJobHandlers({
    executor,
    prisma,
    sandbox,
    home,
    jobs,
    events,
    workerId: "api",
    runtime,
    secretStore: secrets,
    memoryProviders,
    deploymentModelKey: env.deploymentModelKey,
    messaging,
    cloudAgent,
  });
  if (inMemoryJobs) {
    await inMemoryJobs.start(jobHandlers);
  }
  const reconciler = inMemoryJobs
    ? createJobReconciler({
        prisma,
        jobs,
        events,
        notifications,
        reconcileCloudAgents: () => reconcileCloudAgents({ prisma, jobs, cloudAgent }),
        reconcileComputerUpdates: () => reconcileComputerUpdates({ prisma, jobs }),
      })
    : undefined;
  reconciler?.start();

  const router = createRouter({
    cloudAgent,
    codexCatalog,
    prisma,
    events,
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
    composio: stack.composio,
    connectors: stack.connector,
    remoteConnectors,
    artifacts,
    dataDir: env.dataDir,
    billing,
    messaging: {
      enabled: Boolean(messaging),
      providers: messaging?.platforms().map((platform) => platform.provider) ?? [],
      openSignup: env.messagingOpenSignup,
    },
    env: {
      agentRuntime: env.agentRuntime,
      defaultProvider: env.defaultProvider,
      defaultModel: env.defaultModel,
      teamChatJudgeProvider: env.teamChatJudgeProvider,
      teamChatJudgeModel: env.teamChatJudgeModel,
      deploymentModelKey: env.deploymentModelKey,
      webOrigin: env.webOrigin,
      privacyPolicyUrl: env.privacyPolicyUrl,
      screenProxySecret: env.screenProxySecret,
      sandboxProvider: env.sandboxProvider,
      gitSha: env.gitSha,
      updaterUrl: env.updaterUrl,
      updaterToken: env.updaterToken,
      imageTag: env.imageTag,
      integrationsCatalogUrl: env.integrationsCatalogUrl,
      mcpAllowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
    },
  });
  const rpc = new RPCHandler(router, {
    clientInterceptors: [onError((error, { path }) => logUnexpectedRpcError(error, path))],
  });
  const app = new Hono();
  app.use("*", requestLogging(logger));
  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return env.webOrigin;
        return isTrustedOrigin(origin, env) ? origin : "";
      },
      credentials: true,
    }),
  );
  app.get("/api/auth/capabilities", (c) => {
    c.header("cache-control", "no-store");
    return c.json({
      sso: env.oidc
        ? { name: env.oidc.name, availability: auth.ssoAvailability() ?? "checking" }
        : null,
      passwordAuth: env.passwordAuth !== false,
      passwordReset: env.passwordAuth !== false && Boolean(email),
      resetUrl:
        env.passwordAuth !== false && email ? new URL("/reset-password", env.webOrigin).href : null,
      billing: Boolean(billing),
    } satisfies AuthCapabilities);
  });
  if (localEmailEmulator && env.nodeEnv === "development") {
    app.get(
      "/api/dev/emails",
      () =>
        new Response(JSON.stringify(localEmailEmulator.sent), {
          headers: { "cache-control": "no-store", "content-type": "application/json" },
        }),
    );
  }
  mountApiRequestBodyLimits(app);
  mountScreenTarget(app, prisma, env.screenProxySecret);
  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    const path = new URL(c.req.url).pathname.replace("/api/auth", "");
    if (isBlockedAuthPath(path)) {
      return c.json({ error: "Not available in version 1" }, 404);
    }
    return auth.handler(c.req.raw);
  });
  mountLocalSettings(app, { token: env.desktopStackToken, prisma, rpc });
  const requestSession = async (request: Request) => {
    const session = await auth.api.getSession({ headers: sessionHeaders(request) });
    if (!session?.user) return null;
    const actor = await actorFromMembership(
      requireMembership(prisma, session.user.id, request.headers.get("x-rakazo-space-id")),
    );
    return actor && { actor, sessionId: session.session.id };
  };
  const sessionActor = async (request: Request) => (await requestSession(request))?.actor ?? null;
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
  mountVoiceHttpRoutes(app, { prisma, secrets }, async (c) => {
    const actor = await sessionActor(c.req.raw);
    if (actor) enrichLogContext({ "user.id": actor.userId, "space.id": actor.spaceId });
    return actor;
  });
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
  let clearMessagingRetryDelay: (() => void) | undefined;
  let messagingInitTask: Promise<void> | undefined;
  let clearTeamChatRetryDelay: (() => void) | undefined;
  let teamChatInitTask: Promise<void> | undefined;
  // Messaging webhooks only exist when the surface is enabled.
  let teamChatBridge: TeamChatBridge | undefined;
  /** Constructed even before start() succeeds so stop() can cancel in-flight startup. */
  let teamChatBridgeInstance: TeamChatBridge | undefined;
  const pendingTeamChatInbound = new PendingTeamChatInbound();
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
      typing: (threadId) => {
        // Keep conversation addresses out of trace ids — those reach logs
        // and telemetry, a different trust boundary than the database.
        const operationId = `messaging.typing:${randomUUID()}`;
        return messaging.sendTyping(threadId, {
          operationId,
          traceId: operationId,
          spaceId: "",
          userId: "",
          // Cosmetic side call: the wait is bounded so a stalled vendor
          // response never holds our callback chain (the Chat SDK adapter
          // API cannot cancel the underlying request itself).
          signal: AbortSignal.timeout(2000),
        });
      },
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
    if (env.teamChatBotId) {
      const judge =
        env.teamChatJudgeProvider && env.teamChatJudgeModel
          ? new ModelTeamChatEngagementJudge({
              prisma,
              runtime,
              secrets,
              deploymentProvider: env.defaultProvider,
              deploymentModel: env.defaultModel,
              deploymentModelKey: env.deploymentModelKey,
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
            });
      const bridge = new TeamChatBridge({
        prisma,
        events,
        jobs,
        send: createMessagingTeamChatSender(messaging),
        providerId: "slack",
        botId: env.teamChatBotId,
        judge,
      });
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
    messaging.onInbound(async (event) => {
      if (event.type !== "message") {
        await applyMessagingOutboundStatus(prisma, event);
        return;
      }
      if (prefersTeamChatSurface(event, env.teamChatBotId)) {
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
    });
    mountMessagingWebhookRoutes(app, { messaging });
    // Start polling-mode adapters (e.g. Telegram with no public webhook URL
    // registered) immediately rather than waiting for the first webhook
    // POST or outbound send to lazily trigger it. This is the process that
    // owns the inbound sink registered just above, so it must be the one
    // holding the live connection — a second poller elsewhere (e.g. the
    // worker) would only fight this one for Telegram's single getUpdates
    // slot without ever seeing the messages itself.
    // Bounded retries cover transient Telegram startup failures; polling-only
    // bots otherwise stay dark until an unrelated outbound send re-inits.
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
    healthRoutes(() => ({
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
    })),
  );

  return {
    app,
    prisma,
    jobs,
    sandbox,
    connector,
    composio: stack.composio,
    connectors: stack.connector,
    messaging,
    email,
    executor,
    runtime,
    awaitIdle: inMemoryJobs ? () => inMemoryJobs.awaitIdle() : undefined,
    backgroundFailures: inMemoryJobs ? () => inMemoryJobs.failureCounts() : undefined,
    stop: async () => {
      // Abort in-flight continueRun boot waits before draining jobs so stop() cannot sit
      // on waitForComputerReady for the full boot-wait window during shared Postgres journeys.
      auth.disposeOidcDiscovery();
      shutdown.abort();
      oauthLogins.abortAll();
      messagingStopped = true;
      clearMessagingRetryDelay?.();
      clearTeamChatRetryDelay?.();
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
      await email?.drain?.();
      await reconciler?.stop();
      await jobs.close();
      await secrets.close();
      await realtime.close();
      await connector.stop();
      await mcp.close();
      await prisma.$disconnect().catch(() => undefined);
      await created.pool?.end().catch(() => undefined);
      await ownedJobPool?.end().catch(() => undefined);
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

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
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

function sessionHeaders(request: Request) {
  const headers = new Headers(request.headers);
  const authz = headers.get("authorization");
  if (authz?.toLowerCase().startsWith("bearer ") && !headers.get("cookie")) {
    headers.set("cookie", `better-auth.session_token=${authz.slice(7).trim()}`);
  }
  return headers;
}

/**
 * An ORPCError is a decision the router made (BAD_REQUEST, UNAUTHORIZED, ...) and reaches the
 * caller intact. Everything else is flattened into an opaque "Internal server error", so
 * unless it is logged here the only record of what actually broke is gone.
 *
 * The cause chain matters as much as the message: undici and most SDKs report a bare
 * "fetch failed" and keep the host and errno one level down.
 */
export function logUnexpectedRpcError(error: unknown, path: readonly string[]): void {
  if (error instanceof ORPCError) return;
  const where = `rpc ${path.join("/")} failed`;
  getLogger().error(where, error);
}
