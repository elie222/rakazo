import { hostname } from "node:os";
import type {
  ArtifactStore,
  BackgroundJobPayloads,
  ConnectorProvider,
  ManagedConnectorProvider,
  MessagingSurface,
  SecretStore,
  WorkspaceExportLimits,
} from "@rakazo/adapter-kit";
import type { LabFeature } from "@rakazo/contracts";
import {
  availableChatApps,
  messagingProviderName,
  phoneCallSettings,
  uploadSizeFromEnv,
} from "@rakazo/core";
import { resolveEncryptionKey } from "@rakazo/core/node/secrets-guard";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  chatHistoryRetentionDays,
  createChatHistoryPruner,
  createSecurityEventPruner,
  securityEventRetentionDays,
} from "@rakazo/db";
import { cliModelRuntime } from "../../cli-models/runtime.js";
import { reconcileCloudAgents } from "../../cloud-agents/cloud-agent-service.js";
import { createIdleComputerSweeper } from "../../computers/computer-idle.js";
import { reconcileComputerUpdates } from "../../computers/computer-update.js";
import { createConnectorStack } from "../../integrations/connector-registry.js";
import type { RemoteConnectorDependencies } from "../../integrations/installed-connectors.js";
import { InstalledConnectorProvider } from "../../integrations/installed-connectors.js";
import { IntegrationProviderSettings } from "../../integrations/integration-provider-settings.js";
import { McpConnector, mcpStdioOptionsFromEnv } from "../../mcp/mcp-connector.js";
import { McpOAuthBroker } from "../../mcp/mcp-oauth.js";
import { reconcileMediaVideos } from "../../media/media-video-poll.js";
import { createMessagingContextLoader } from "../../messaging/messaging-context.js";
import { MessagingDelivery } from "../../messaging/messaging-delivery.js";
import { TeamChat } from "../../messaging/team-chat/team-chat.js";
import { ModelTeamChatEngagementJudge } from "../../messaging/team-chat/team-chat-judge.js";
import { modelCreditUsageLookup } from "../../model-credits/routing.js";
import { createModelCreditReconciler } from "../../models/credits/model-credit-reconciler.js";
import {
  deploymentModelUsageLookup,
  resolveDeploymentModel,
} from "../../models/deployment-model.js";
import { ExpoPushProvider } from "../../notifications/expo-push.js";
import { reconcilePurchases } from "../../payments/purchase-poll.js";
import { T3CodeConnections } from "../../providers/cloud-agent/t3code/t3code-connections.js";
import type { ComposioProvider } from "../../providers/integration/composio/composio-connector.js";
import {
  ComposioConnector,
  isComposioEnabled,
} from "../../providers/integration/composio/composio-connector.js";
import type { PipedreamEnvironmentValues } from "../../providers/integration/pipedream/pipedream-connector.js";
import {
  isPipedreamEnabled,
  PipedreamConnector,
  pipedreamConfigFromEnv,
} from "../../providers/integration/pipedream/pipedream-connector.js";
import { createStrategicInitiativeReconciler } from "../../routines/strategic-initiative.js";
import { localModelsApiKey } from "../../runtime/pi/models/pi-local-provider-id.js";
import type { SecretCleanupDeps } from "../../secrets/secret-cleanup.js";
import { workspaceSaveLimits } from "../../storage/workspace-save-policy.js";
import { createWebProvider } from "../../web/web-provider-factory.js";
import { auditLogConfig, createAuditLogReconciler } from "../../webhooks/audit-forwarding.js";
import { createRunExecutor } from "../executor/executor.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { deploymentLabsFromEnv } from "../labs-env.js";
import { createBackgroundJobHandlers } from "../wakeups/background-job-handlers.js";
import { createJobReconciler } from "../wakeups/job-reconciler.js";

/**
 * Settings the run runtime reads. The API passes its parsed env, so its test overrides apply;
 * the worker passes `runRuntimeEnvFromProcess`.
 */
export interface RunRuntimeEnv extends PipedreamEnvironmentValues {
  dataDir: string;
  composioApiKey: string | undefined;
  cursorApiKey: string | undefined;
  deploymentModelKey: string | undefined;
  deploymentModelConfigured: boolean;
  /** The deployment model, which judges ambient team-chat messages unless overridden. */
  defaultProvider: string;
  defaultModel: string;
  teamChatJudgeProvider: string | undefined;
  teamChatJudgeModel: string | undefined;
  mcpStdioEnabled: boolean;
  mcpStdioAllowedCommands: string[];
  mcpStdio: ReturnType<typeof mcpStdioOptionsFromEnv>;
  mcpAllowPrivateEndpoint: boolean;
  deploymentLabs: LabFeature[];
  phoneCallsEnabled: boolean;
  phoneCallRingSeconds: number;
  phoneCallCooldownMinutes: number;
  maxUploadSizeBytes: number;
  /** What one computer save may copy; read once from `WORKSPACE_SAVE_MAX_GB`. */
  workspaceSaveLimits: WorkspaceExportLimits;
  /** Only names a bot's address to it; the API receives the mail. */
  inboundEmailDomain: string | undefined;
}

/** The worker's reading of the run runtime settings, values and defaults as the worker has them. */
export function runRuntimeEnvFromProcess(source: NodeJS.ProcessEnv): RunRuntimeEnv {
  // Same resolver the API uses, so both processes agree on provider, model and key.
  const deploymentModel = resolveDeploymentModel(source);
  return {
    dataDir: source.DATA_DIR ?? "./data",
    encryptionKey: resolveEncryptionKey(source),
    composioApiKey: source.COMPOSIO_API_KEY,
    cursorApiKey: source.CURSOR_API_KEY,
    deploymentModelKey: deploymentModel.key,
    deploymentModelConfigured: deploymentModel.configured,
    defaultProvider: deploymentModel.provider,
    defaultModel: deploymentModel.model,
    teamChatJudgeProvider: source.TEAM_CHAT_JUDGE_PROVIDER?.trim() || undefined,
    teamChatJudgeModel: source.TEAM_CHAT_JUDGE_MODEL?.trim() || undefined,
    mcpStdioEnabled: source.MCP_STDIO_ENABLED === "true",
    mcpStdioAllowedCommands: (source.MCP_STDIO_ALLOWED_COMMANDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    mcpStdio: mcpStdioOptionsFromEnv(source),
    mcpAllowPrivateEndpoint: source.MCP_ALLOW_PRIVATE_ENDPOINT === "true",
    pipedreamClientId: source.PIPEDREAM_CLIENT_ID,
    pipedreamClientSecret: source.PIPEDREAM_CLIENT_SECRET,
    pipedreamProjectId: source.PIPEDREAM_PROJECT_ID,
    pipedreamEnvironment: source.PIPEDREAM_ENVIRONMENT,
    deploymentLabs: deploymentLabsFromEnv(source),
    ...phoneCallSettings(source),
    maxUploadSizeBytes: uploadSizeFromEnv(source),
    workspaceSaveLimits: workspaceSaveLimits(source),
    inboundEmailDomain: source.INBOUND_EMAIL_DOMAIN?.trim().toLowerCase() || undefined,
  };
}

/** Test stand-ins the API can put in place of the configured connectors. */
export interface ConnectorRuntimeOverrides {
  network?: RemoteConnectorDependencies;
  composio?: ComposioProvider;
  pipedream?: ManagedConnectorProvider;
  /** Registered beside the configured providers. */
  connectors?: ConnectorProvider[];
}

/** MCP, installed and integration connectors, in the one registry runs use. */
export function createConnectorRuntime(
  env: RunRuntimeEnv,
  deps: {
    prisma: PrismaClient;
    secrets: SecretStore;
    events: ThreadEvents;
    jobs: SecretCleanupDeps["jobs"];
  },
  overrides: ConnectorRuntimeOverrides = {},
) {
  const { prisma, secrets } = deps;
  const { network, composio } = overrides;
  const mcpOAuth = new McpOAuthBroker(
    prisma,
    secrets,
    network,
    env.mcpAllowPrivateEndpoint,
    deps.jobs,
  );
  const mcp = new McpConnector(
    prisma,
    secrets,
    {
      stdioEnabled: env.mcpStdioEnabled,
      allowedCommands: env.mcpStdioAllowedCommands,
      ...env.mcpStdio,
      network,
      events: deps.events,
      allowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
    },
    mcpOAuth,
  );
  const pipedreamConfig = pipedreamConfigFromEnv(env);
  const pipedream =
    overrides.pipedream ??
    (isPipedreamEnabled(pipedreamConfig) ? new PipedreamConnector(pipedreamConfig) : undefined);
  const installed = new InstalledConnectorProvider(
    prisma,
    secrets,
    network,
    env.mcpAllowPrivateEndpoint,
  );
  const integrationSettings = new IntegrationProviderSettings(prisma, secrets, env.encryptionKey, {
    composio:
      composio ??
      (isComposioEnabled(env.composioApiKey)
        ? new ComposioConnector({ apiKey: env.composioApiKey })
        : undefined),
    pipedream,
  });
  const stack = createConnectorStack(composio, [
    installed,
    ...integrationSettings
      .providers()
      .filter((provider) => !composio || provider.describe().id !== "composio"),
    mcp,
    ...(overrides.connectors ?? []),
  ]);
  integrationSettings.warmDirectories();
  const userCloudAgents = new T3CodeConnections(prisma, mcpOAuth, {
    ...network,
    allowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
  });
  return { mcpOAuth, mcp, pipedream, installed, integrationSettings, stack, userCloudAgents };
}

export type ConnectorRuntime = ReturnType<typeof createConnectorRuntime>;

type SetByRunRuntime =
  | "connector"
  | "connectors"
  | "userCloudAgents"
  | "listConnectedPlugins"
  | "secrets"
  | "mcpAllowPrivateEndpoint"
  | "deploymentModelKey"
  | "deploymentModelConfigured"
  | "dataDir"
  | "deploymentLabs"
  | "phoneCallsEnabled"
  | "phoneCallRingSeconds"
  | "phoneCallCooldownMinutes"
  | "inboundEmailDomain"
  | "maxUploadSizeBytes"
  | "messaging"
  | "messagingDelivery";

/** The run executor and the background job handlers that drive it. */
export function createRunRuntime(
  env: RunRuntimeEnv,
  connectors: ConnectorRuntime,
  deps: Omit<ExecutorDeps, SetByRunRuntime> & {
    artifacts: ArtifactStore;
    messaging?: MessagingSurface;
    /** Whether a connected workspace still has its bot installed. */
    isMessagingInstallationActive?: (installationId: string) => Promise<boolean>;
    /** Answers the lifecycle-mail job where account mail is configured. */
    meetingCalendarSync?: (job: BackgroundJobPayloads["meeting.calendar-sync"]) => Promise<void>;
    meetingWork?: (job: BackgroundJobPayloads["meeting.work"]) => Promise<unknown>;
    lifecycleEmail?: (job: BackgroundJobPayloads["email.lifecycle"]) => Promise<void>;
  },
) {
  const {
    messaging,
    isMessagingInstallationActive,
    lifecycleEmail,
    meetingWork,
    meetingCalendarSync,
    ...executorDeps
  } = deps;
  const runtime = cliModelRuntime(env, deps.runtime, deps);
  const messagingDelivery = messaging
    ? new MessagingDelivery({
        prisma: deps.prisma,
        messaging,
        events: deps.events,
        jobs: deps.jobs,
        artifacts: deps.artifacts,
      })
    : undefined;
  const teamChat = messaging
    ? new TeamChat({
        prisma: deps.prisma,
        events: deps.events,
        jobs: deps.jobs,
        isInstallationActive: isMessagingInstallationActive,
        judge: new ModelTeamChatEngagementJudge({
          prisma: deps.prisma,
          runtime,
          secrets: deps.secretStore,
          deploymentProvider: env.defaultProvider,
          deploymentModel: env.defaultModel,
          deploymentModelKey: env.deploymentModelKey,
          allowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
          ...(env.teamChatJudgeProvider && env.teamChatJudgeModel
            ? {
                providerOverride: env.teamChatJudgeProvider,
                modelOverride: env.teamChatJudgeModel,
              }
            : {}),
        }),
      })
    : undefined;
  const executor = createRunExecutor({
    ...executorDeps,
    runtime,
    maxUploadSizeBytes: env.maxUploadSizeBytes,
    connector: connectors.stack.connector,
    connectors: connectors.stack.connector,
    userCloudAgents: connectors.userCloudAgents,
    listConnectedPlugins: (userId) => connectors.integrationSettings.listConnectedPlugins(userId),
    secrets: [
      env.deploymentModelKey ?? "",
      localModelsApiKey() ?? "",
      env.composioApiKey ?? "",
      env.cursorApiKey ?? "",
      process.env.TYPESAFE_API_KEY ?? "",
    ].filter(Boolean),
    mcpAllowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
    deploymentModelKey: env.deploymentModelKey,
    deploymentModelConfigured: env.deploymentModelConfigured,
    dataDir: env.dataDir,
    deploymentLabs: env.deploymentLabs,
    phoneCallsEnabled: env.phoneCallsEnabled,
    phoneCallRingSeconds: env.phoneCallRingSeconds,
    phoneCallCooldownMinutes: env.phoneCallCooldownMinutes,
    inboundEmailDomain: env.inboundEmailDomain,
    messaging: messaging
      ? {
          ...createMessagingContextLoader(deps.prisma),
          chatApps: () =>
            availableChatApps(
              messaging.platforms().map((platform) => platform.provider),
              Boolean(isMessagingInstallationActive),
            ).map(messagingProviderName),
        }
      : undefined,
    messagingDelivery,
    web: executorDeps.web ?? createWebProvider(),
  });
  const jobHandlers = createBackgroundJobHandlers({
    executor,
    prisma: deps.prisma,
    sandbox: deps.sandbox,
    home: deps.home,
    artifacts: deps.artifacts,
    jobs: deps.jobs,
    events: deps.events,
    // Every container runs node as the same pid, and deploys run old and new side by side.
    workerId: `${hostname()}:${process.pid}`,
    runtime,
    notifications: deps.notifications instanceof ExpoPushProvider ? deps.notifications : undefined,
    secretStore: deps.secretStore,
    memoryProviders: deps.memoryProviders,
    deploymentModelKey: env.deploymentModelKey,
    deploymentModelConfigured: env.deploymentModelConfigured,
    messagingDelivery,
    teamChat,
    connectors: connectors.stack.connector,
    cloudAgent: deps.cloudAgent,
    userCloudAgents: connectors.userCloudAgents,
    paymentWallet: deps.paymentWallet,
    mediaGeneration: deps.mediaGeneration,
    maxUploadSizeBytes: env.maxUploadSizeBytes,
    lifecycleEmail,
    meetingWork,
    meetingCalendarSync,
  });
  return { runtime, executor, jobHandlers, messagingDelivery, teamChat };
}

type JobReconcilerDeps = Parameters<typeof createJobReconciler>[0];

/** The periodic recovery and cleanup passes; the worker adds the ones that need its pool. */
export function createRunReconciler(
  deps: Pick<
    ExecutorDeps,
    | "prisma"
    | "jobs"
    | "events"
    | "notifications"
    | "billingEnabled"
    | "mediaGeneration"
    | "secretStore"
  > & {
    cloudAgent: NonNullable<ExecutorDeps["cloudAgent"]> | null;
    userCloudAgents?: ExecutorDeps["userCloudAgents"];
    paymentWallet: NonNullable<ExecutorDeps["paymentWallet"]> | null;
  },
  workerOnly: Pick<
    JobReconcilerDeps,
    "leadership" | "reconcileRoutineRetryNotices" | "reconcileHomeStorage" | "reconcileDeadJobs"
  > = {},
  chat: { messagingDelivery?: MessagingDelivery; teamChat?: TeamChat } = {},
) {
  const { prisma, jobs, cloudAgent, paymentWallet, mediaGeneration } = deps;
  const { messagingDelivery, teamChat } = chat;
  const chatHistoryDays = chatHistoryRetentionDays();
  return createJobReconciler({
    prisma,
    jobs,
    events: deps.events,
    notifications: deps.notifications,
    ...workerOnly,
    reconcileChatDelivery:
      messagingDelivery && teamChat
        ? async () => {
            await messagingDelivery.sweepStalled();
            await teamChat.sweepStalled();
          }
        : undefined,
    reconcileModelCredits: createModelCreditReconciler({
      prisma,
      lookup: deploymentModelUsageLookup(),
      lookupForOffering: (offering) => modelCreditUsageLookup(prisma, deps.secretStore, offering),
    }),
    reconcileStrategicInitiatives: createStrategicInitiativeReconciler({
      prisma,
      jobs,
      billingEnabled: deps.billingEnabled,
    }),
    reconcileCloudAgents: () =>
      reconcileCloudAgents({ prisma, jobs, cloudAgent, userCloudAgents: deps.userCloudAgents }),
    reconcilePurchases: () => reconcilePurchases({ prisma, jobs, paymentWallet }),
    reconcileMediaVideos: () => reconcileMediaVideos({ prisma, jobs, mediaGeneration }),
    reconcileComputerUpdates: () => reconcileComputerUpdates({ prisma, jobs, events: deps.events }),
    reconcileSecurityEventRetention: createSecurityEventPruner(
      prisma,
      securityEventRetentionDays(),
    ),
    reconcileAuditLog: createAuditLogReconciler(prisma, auditLogConfig()),
    reconcileChatHistoryRetention:
      chatHistoryDays === null ? undefined : createChatHistoryPruner(prisma, chatHistoryDays),
    reconcileIdleComputers: createIdleComputerSweeper({ prisma, jobs }),
  });
}
