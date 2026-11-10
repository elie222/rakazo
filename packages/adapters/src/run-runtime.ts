import { hostname } from "node:os";
import type {
  ArtifactStore,
  ConnectorProvider,
  ManagedConnectorProvider,
  MessagingSurface,
  SecretStore,
} from "@rakazo/adapter-kit";
import { phoneCallSettings, resolveEncryptionKey, uploadSizeFromEnv } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { createSecurityEventPruner, securityEventRetentionDays } from "@rakazo/db";
import { auditLogConfig, createAuditLogReconciler } from "./audit-forwarding.js";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import { reconcileCloudAgents } from "./cloud-agent-service.js";
import type { ComposioProvider } from "./composio-connector.js";
import { ComposioConnector, isComposioEnabled } from "./composio-connector.js";
import { createIdleComputerSweeper } from "./computer-idle.js";
import { reconcileComputerUpdates } from "./computer-update.js";
import { createConnectorStack } from "./connector-registry.js";
import type { DeploymentModels } from "./deployment-model.js";
import {
  deploymentModelUsageLookup,
  environmentDeploymentModels,
  resolveDeploymentModel,
} from "./deployment-model.js";
import { createRunExecutor } from "./executor.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { ExpoPushProvider } from "./expo-push.js";
import type { RemoteConnectorDependencies } from "./installed-connectors.js";
import { InstalledConnectorProvider } from "./installed-connectors.js";
import { IntegrationProviderSettings } from "./integration-provider-settings.js";
import { createJobReconciler } from "./job-reconciler.js";
import { McpConnector, mcpStdioOptionsFromEnv } from "./mcp-connector.js";
import { McpOAuthBroker } from "./mcp-oauth.js";
import { reconcileMediaVideos } from "./media-video-poll.js";
import { createMessagingContextLoader } from "./messaging-context.js";
import { createModelCreditReconciler } from "./model-credit-reconciler.js";
import { localModelsApiKey } from "./pi-local-provider-id.js";
import type { PipedreamEnvironmentValues } from "./pipedream-connector.js";
import {
  isPipedreamEnabled,
  PipedreamConnector,
  pipedreamConfigFromEnv,
} from "./pipedream-connector.js";
import { reconcilePurchases } from "./purchase-poll.js";
import { createStrategicInitiativeReconciler } from "./strategic-initiative.js";
import { createWebProvider } from "./web-provider-factory.js";

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
  /** The environment's deployment connections and allowlist; admins' settings apply over them. */
  deploymentModels: DeploymentModels;
  mcpStdioEnabled: boolean;
  mcpStdioAllowedCommands: string[];
  mcpStdio: ReturnType<typeof mcpStdioOptionsFromEnv>;
  mcpAllowPrivateEndpoint: boolean;
  ticketBoardEnabled: boolean;
  phoneCallsEnabled: boolean;
  phoneCallRingSeconds: number;
  phoneCallCooldownMinutes: number;
  maxUploadSizeBytes: number;
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
    deploymentModels: environmentDeploymentModels(source, deploymentModel),
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
    ticketBoardEnabled: source.TICKET_BOARD_ENABLED === "true",
    ...phoneCallSettings(source),
    maxUploadSizeBytes: uploadSizeFromEnv(source),
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
  deps: { prisma: PrismaClient; secrets: SecretStore; events: ThreadEvents },
  overrides: ConnectorRuntimeOverrides = {},
) {
  const { prisma, secrets } = deps;
  const { network, composio } = overrides;
  const mcpOAuth = new McpOAuthBroker(prisma, secrets, network, env.mcpAllowPrivateEndpoint);
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
  return { mcpOAuth, mcp, pipedream, installed, integrationSettings, stack };
}

export type ConnectorRuntime = ReturnType<typeof createConnectorRuntime>;

type SetByRunRuntime =
  | "connector"
  | "connectors"
  | "listConnectedPluginSlugs"
  | "secrets"
  | "mcpAllowPrivateEndpoint"
  | "deploymentModelKey"
  | "deploymentModelConfigured"
  | "deploymentModels"
  | "dataDir"
  | "ticketBoardEnabled"
  | "phoneCallsEnabled"
  | "phoneCallRingSeconds"
  | "phoneCallCooldownMinutes"
  | "inboundEmailDomain"
  | "maxUploadSizeBytes"
  | "messaging"
  | "web";

/** The run executor and the background job handlers that drive it. */
export function createRunRuntime(
  env: RunRuntimeEnv,
  connectors: ConnectorRuntime,
  deps: Omit<ExecutorDeps, SetByRunRuntime> & {
    artifacts: ArtifactStore;
    messaging?: MessagingSurface;
  },
) {
  const { messaging, ...executorDeps } = deps;
  const executor = createRunExecutor({
    ...executorDeps,
    maxUploadSizeBytes: env.maxUploadSizeBytes,
    connector: connectors.stack.connector,
    connectors: connectors.stack.connector,
    listConnectedPluginSlugs: (userId) =>
      connectors.integrationSettings.listConnectedPluginSlugs(userId),
    secrets: [
      env.deploymentModelKey ?? "",
      ...env.deploymentModels.connections.map((connection) => connection.key ?? ""),
      localModelsApiKey() ?? "",
      env.composioApiKey ?? "",
      env.cursorApiKey ?? "",
      process.env.TYPESAFE_API_KEY ?? "",
    ].filter(Boolean),
    mcpAllowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
    deploymentModelKey: env.deploymentModelKey,
    deploymentModelConfigured: env.deploymentModelConfigured,
    deploymentModels: env.deploymentModels,
    dataDir: env.dataDir,
    ticketBoardEnabled: env.ticketBoardEnabled,
    phoneCallsEnabled: env.phoneCallsEnabled,
    phoneCallRingSeconds: env.phoneCallRingSeconds,
    phoneCallCooldownMinutes: env.phoneCallCooldownMinutes,
    inboundEmailDomain: env.inboundEmailDomain,
    messaging: messaging ? createMessagingContextLoader(deps.prisma) : undefined,
    web: createWebProvider(),
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
    runtime: deps.runtime,
    notifications: deps.notifications instanceof ExpoPushProvider ? deps.notifications : undefined,
    secretStore: deps.secretStore,
    memoryProviders: deps.memoryProviders,
    deploymentModelKey: env.deploymentModelKey,
    deploymentModelConfigured: env.deploymentModelConfigured,
    messaging,
    cloudAgent: deps.cloudAgent,
    paymentWallet: deps.paymentWallet,
    mediaGeneration: deps.mediaGeneration,
    maxUploadSizeBytes: env.maxUploadSizeBytes,
  });
  return { executor, jobHandlers };
}

type JobReconcilerDeps = Parameters<typeof createJobReconciler>[0];

/** The periodic recovery and cleanup passes; the worker adds the ones that need its pool. */
export function createRunReconciler(
  deps: Pick<
    ExecutorDeps,
    | "prisma"
    | "secretStore"
    | "jobs"
    | "events"
    | "notifications"
    | "billingEnabled"
    | "mediaGeneration"
  > & {
    cloudAgent: NonNullable<ExecutorDeps["cloudAgent"]> | null;
    paymentWallet: NonNullable<ExecutorDeps["paymentWallet"]> | null;
  },
  workerOnly: Pick<
    JobReconcilerDeps,
    "leadership" | "reconcileRoutineRetryNotices" | "reconcileHomeStorage" | "reconcileDeadJobs"
  > = {},
) {
  const { prisma, jobs, cloudAgent, paymentWallet, mediaGeneration } = deps;
  return createJobReconciler({
    prisma,
    jobs,
    events: deps.events,
    notifications: deps.notifications,
    ...workerOnly,
    reconcileModelCredits: createModelCreditReconciler({
      prisma,
      lookup: deploymentModelUsageLookup(deps),
    }),
    reconcileStrategicInitiatives: createStrategicInitiativeReconciler({
      prisma,
      jobs,
      billingEnabled: deps.billingEnabled,
    }),
    reconcileCloudAgents: () => reconcileCloudAgents({ prisma, jobs, cloudAgent }),
    reconcilePurchases: () => reconcilePurchases({ prisma, jobs, paymentWallet }),
    reconcileMediaVideos: () => reconcileMediaVideos({ prisma, jobs, mediaGeneration }),
    reconcileComputerUpdates: () => reconcileComputerUpdates({ prisma, jobs }),
    reconcileSecurityEventRetention: createSecurityEventPruner(
      prisma,
      securityEventRetentionDays(),
    ),
    reconcileAuditLog: createAuditLogReconciler(prisma, auditLogConfig()),
    reconcileIdleComputers: createIdleComputerSweeper({ prisma, jobs }),
  });
}
