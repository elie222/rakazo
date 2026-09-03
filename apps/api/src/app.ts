import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type {
  JobPublisher,
  ManagedConnectorProvider,
  MessagingSurface,
  RealtimeFanout,
  SandboxProvider,
  TeamChatProvider,
  TransactionalEmailProvider,
} from "@rakazo/adapter-kit";
import {
  applyMessagingOutboundStatus,
  ChatSdkMessagingSurface,
  type ComposioProvider,
  type ConnectorRegistry,
  createBackgroundJobHandlers,
  createConnectorStack,
  createJobReconciler,
  createMessagingContextLoader,
  createRunExecutor,
  createRunSandbox,
  createRunSecretWriter,
  createWebProvider,
  type DestinationEmulator,
  destroyBot,
  EmailEmulator,
  EncryptedSecretStore,
  ExpoPushProvider,
  GraphileJobPublisher,
  InMemoryJobQueue,
  InMemoryRealtimeFanout,
  InstalledConnectorProvider,
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
  pushTokenPath,
  type RemoteConnectorDependencies,
  ScriptedAgentRuntime,
  SlackTeamChatProvider,
  SmtpEmailProvider,
  SpaceMemoryProviderResolver,
} from "@rakazo/adapters";
import { blockedAuthPaths, createAuth } from "@rakazo/auth";
import { signupPolicyFromEnv } from "@rakazo/core";
import {
  createDb,
  createThreadEvents,
  type PrismaClient,
  provisionMessagingIdentity,
  requireMembership,
} from "@rakazo/db";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { type AppEnv, loadEnv } from "./env.js";
import { createMessagingInboundHandler } from "./messaging-inbound.js";
import { mountMessagingWebhookRoutes } from "./messaging-webhook.js";
import { createRouter } from "./router.js";
import { TeamChatBridge } from "./team-chat-bridge.js";
import { ModelTeamChatEngagementJudge } from "./team-chat-judge.js";
import { mountVoiceHttpRoutes } from "./voice.js";
import { mountWebhookHttpRoutes } from "./webhook.js";

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
  teamChat?: TeamChatProvider;
  executor: ReturnType<typeof createRunExecutor>;
  stop: () => Promise<void>;
}

export async function createApp(
  overrides: Partial<AppEnv> & {
    prisma?: PrismaClient;
    realtime?: RealtimeFanout;
    composio?: ComposioProvider;
    pipedream?: ManagedConnectorProvider;
    messaging?: MessagingSurface;
    email?: TransactionalEmailProvider;
    teamChat?: TeamChatProvider;
    remoteConnectors?: RemoteConnectorDependencies;
  } = {},
): Promise<AppHandles> {
  const {
    prisma: prismaOverride,
    realtime: realtimeOverride,
    composio: composioOverride,
    pipedream: pipedreamOverride,
    messaging: messagingOverride,
    email: emailOverride,
    teamChat: teamChatOverride,
    remoteConnectors,
    ...envOverrides
  } = overrides;
  const env = { ...loadEnv(process.env), ...envOverrides };
  const created = prismaOverride
    ? { prisma: prismaOverride, pool: undefined }
    : createDb(env.databaseUrl);
  const { prisma } = created;
  created.pool?.on("error", () => undefined);
  const realtime =
    realtimeOverride ??
    (created.pool
      ? new PostgresRealtimeFanout({
          connectionString: env.realtimeDatabaseUrl,
          publisher: created.pool,
        })
      : new InMemoryRealtimeFanout());
  const secrets = new EncryptedSecretStore(env.encryptionKey);
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
    // so upgrades preserve behavior before Settings becomes authoritative.
    await prisma.deploymentSettings.updateMany({
      where: { id: "default", signupPolicyInitialized: false },
      data: {
        signupsEnabled: environmentSignupPolicy.enabled,
        signupAllowlist: environmentSignupPolicy.allowlist.join(","),
        signupPolicyInitialized: true,
      },
    });
  }

  const jobKind = env.wakeupDriver;
  const inMemoryJobs = jobKind === "memory" ? new InMemoryJobQueue() : undefined;
  const jobs = inMemoryJobs ?? new GraphileJobPublisher(env.databaseUrl);
  const sandbox: SandboxProvider = createRunSandbox(env.sandboxProvider, {
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
  const mcpOAuth = new McpOAuthBroker(prisma, secrets, remoteConnectors);
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
    },
    mcpOAuth,
  );
  const pipedreamConfig = pipedreamConfigFromEnv(env);
  const pipedream =
    pipedreamOverride ??
    (isPipedreamEnabled(pipedreamConfig) ? new PipedreamConnector(pipedreamConfig) : undefined);
  const messagingPlatforms = messagingPlatformsFromEnv(env);
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
          console.info(`[email-emulator] captured ${message.subject} to ${message.to}`);
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
  const teamChat =
    teamChatOverride ?? (env.slack ? new SlackTeamChatProvider(env.slack) : undefined);
  if (teamChat && !env.slackBotId) {
    throw new Error("SLACK_RAKAZO_BOT_ID is required when team chat is enabled");
  }
  const installed = new InstalledConnectorProvider(prisma, secrets, remoteConnectors);
  const stack = createConnectorStack(isComposioEnabled(env.composioApiKey), composioOverride, [
    installed,
    ...(pipedream ? [pipedream] : []),
    mcp,
  ]);
  const connector = stack.destination;
  await connector.start();
  void stack.composio?.warmDirectory().catch(() => undefined);
  void pipedream?.warmDirectory?.().catch(() => undefined);
  const runtime =
    env.agentRuntime === "scripted" ? new ScriptedAgentRuntime() : new PiAgentRuntime();
  const notifications = new ExpoPushProvider(env.dataDir);
  const auth = createAuth(prisma, {
    secret: env.authSecret,
    baseURL: env.authUrl,
    webOrigin: env.webOrigin,
    signupsEnabled: env.signupsEnabled,
    signupAllowlist: env.signupAllowlist,
    email,
    onEmailError: (error) => console.error("transactional email delivery failed", error),
    extraOrigins: [
      "rakazo://",
      "exp://",
      "exp://*",
      "http://localhost:8081",
      "http://127.0.0.1:8081",
      "http://localhost:19006",
      "http://127.0.0.1:19006",
    ],
    beforeDeleteUser: async (userId) => {
      const bots = await prisma.bot.findMany({
        where: { userId },
        select: { id: true, spaceId: true, name: true, archivedAt: true },
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
      await rm(pushTokenPath(env.dataDir, userId), { force: true }).catch(() => undefined);
    },
  });
  const executor = createRunExecutor({
    prisma,
    runtime,
    sandbox,
    memory,
    memoryProviders,
    home,
    artifacts,
    connector: stack.connector,
    connectors: stack.connector,
    listConnectedPluginSlugs: stack.composio?.listConnectedSlugs.bind(stack.composio),
    secrets: [env.deploymentModelKey ?? "", env.composioApiKey ?? ""].filter(Boolean),
    secretStore: secrets,
    deploymentModelKey: env.deploymentModelKey,
    dataDir: env.dataDir,
    notifications,
    jobs,
    events,
    messaging: messaging ? createMessagingContextLoader(prisma) : undefined,
    web: createWebProvider(),
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
  });
  if (inMemoryJobs) {
    await inMemoryJobs.start(jobHandlers);
  }
  const reconciler = inMemoryJobs ? createJobReconciler({ prisma, jobs }) : undefined;
  reconciler?.start();

  const router = createRouter({
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
    mcpOAuth,
    composio: stack.composio,
    connectors: stack.connector,
    remoteConnectors,
    artifacts,
    dataDir: env.dataDir,
    messaging: {
      enabled: Boolean(messaging),
      providers: messaging?.platforms().map((platform) => platform.provider) ?? [],
      openSignup: env.messagingOpenSignup,
    },
    env: {
      defaultProvider: env.defaultProvider,
      defaultModel: env.defaultModel,
      deploymentModelKey: env.deploymentModelKey,
      webOrigin: env.webOrigin,
      screenProxySecret: env.screenProxySecret,
      sandboxProvider: env.sandboxProvider,
      gitSha: env.gitSha,
      updaterUrl: env.updaterUrl,
      updaterToken: env.updaterToken,
      imageTag: env.imageTag,
    },
  });
  const rpc = new RPCHandler(router, {
    clientInterceptors: [onError((error, { path }) => logUnexpectedRpcError(error, path))],
  });
  const app = new Hono();
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
  app.get("/api/auth/capabilities", (c) =>
    c.json({
      passwordReset: Boolean(email),
      resetUrl: email ? new URL("/reset-password", env.webOrigin).href : null,
    }),
  );
  if (localEmailEmulator && env.nodeEnv === "development") {
    app.get(
      "/api/dev/emails",
      () =>
        new Response(JSON.stringify(localEmailEmulator.sent), {
          headers: { "cache-control": "no-store", "content-type": "application/json" },
        }),
    );
  }
  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    const path = new URL(c.req.url).pathname.replace("/api/auth", "");
    if (blockedAuthPaths.some((blocked) => path.startsWith(blocked))) {
      return c.json({ error: "Not available in version 1" }, 404);
    }
    return auth.handler(c.req.raw);
  });
  app.use("/rpc/*", async (c, next) => {
    const session = await auth.api.getSession({ headers: sessionHeaders(c.req.raw) });
    const requestedSpaceId = c.req.header("x-rakazo-space-id");
    const actor = session?.user
      ? await requireMembership(prisma, session.user.id, requestedSpaceId).catch(() => null)
      : null;
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: "/rpc",
      context: { actor, signal: c.req.raw.signal },
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });
  mountVoiceHttpRoutes(app, { prisma, secrets }, async (c) => {
    const session = await auth.api.getSession({ headers: sessionHeaders(c.req.raw) });
    if (!session?.user) return null;
    return requireMembership(prisma, session.user.id, c.req.header("x-rakazo-space-id")).catch(
      () => null,
    );
  });
  mountWebhookHttpRoutes(app, { prisma, secrets, events, jobs });
  // Messaging webhooks only exist when the surface is enabled.
  if (messaging) {
    const inbound = createMessagingInboundHandler({
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
    });
    messaging.onInbound(async (event) => {
      if (event.type === "message") await inbound(event);
      else await applyMessagingOutboundStatus(prisma, event);
    });
    mountMessagingWebhookRoutes(app, { messaging });
  }

  const teamChatBridge =
    teamChat && env.slackBotId
      ? new TeamChatBridge({
          prisma,
          events,
          jobs,
          provider: teamChat,
          botId: env.slackBotId,
          judge: new ModelTeamChatEngagementJudge({
            prisma,
            runtime,
            secrets,
            deploymentProvider: env.defaultProvider,
            deploymentModel: env.defaultModel,
            deploymentModelKey: env.deploymentModelKey,
            providerOverride: env.teamChatJudgeProvider,
            modelOverride: env.teamChatJudgeModel,
          }),
        })
      : undefined;
  let teamChatStarted = false;
  if (teamChatBridge) {
    try {
      await teamChatBridge.start();
      teamChatStarted = true;
    } catch (error) {
      console.error(
        "team chat bridge failed to start",
        error instanceof Error ? error.message : error,
      );
    }
  }

  app.get("/health", (c) =>
    c.json({
      ok: true,
      runtime: env.agentRuntime,
      sandbox: env.sandboxProvider,
      composio: Boolean(stack.composio),
      pipedream: Boolean(pipedream),
      messaging: Boolean(messaging),
      email: email?.describe().id ?? null,
      teamChat: teamChatStarted ? (teamChat?.id ?? null) : null,
      jobs: jobKind,
      realtime: realtime.describe().id,
      revision: env.gitSha ?? null,
    }),
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
    teamChat,
    executor,
    stop: async () => {
      oauthLogins.abortAll();
      await email?.drain?.();
      await teamChatBridge?.stop();
      await reconciler?.stop();
      await jobs.close();
      await realtime.close();
      await connector.stop();
      await mcp.close();
      await prisma.$disconnect().catch(() => undefined);
      await created.pool?.end().catch(() => undefined);
    },
  };
}

function isTrustedOrigin(origin: string, env: AppEnv) {
  if (!origin) return true;
  if (origin === env.webOrigin || origin === env.apiUrl || origin === env.authUrl) return true;
  if (origin.startsWith("rakazo://") || origin.startsWith("exp://")) return true;
  try {
    const host = new URL(origin).hostname;
    return isLoopbackHost(host);
  } catch {
    return false;
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
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
  if (!(error instanceof Error)) {
    console.error(where, String(error));
    return;
  }
  const chain: string[] = [];
  for (let current: unknown = error; current instanceof Error && chain.length < 4; ) {
    chain.push(`${current.name}: ${current.message}`);
    current = current.cause;
  }
  console.error(where, chain.join(" <- "), error.stack ?? "");
}
