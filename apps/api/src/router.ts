import { createHash, randomBytes, randomUUID } from "node:crypto";
import { implement, ORPCError } from "@orpc/server";
import {
  type AdapterContext,
  type AgentHomeStore,
  type ArtifactStore,
  type ConnectorCatalogItem,
  computerControlExpireJobKey,
  type JobPublisher,
  type MemoryStore,
  messagingDeliverJob,
  routineJobKey,
  routineWakeupJob,
  runContinueJob,
  runJobKey,
  type SandboxProvider,
} from "@rakazo/adapter-kit";
import {
  acquireComputerExecutionLease,
  applyTeachingDesktopInput,
  archiveBot,
  buildMcpCredentialBlob,
  buildModelConnectPlaintext,
  type ComposioProvider,
  ComputerBusyError,
  type ComputerExecutionLease,
  type ConnectorRegistry,
  cancelComputerRunWork,
  checkpointAndRecordComputerWorkspace,
  clearInactiveUserComputerControl,
  computerSupportsUpdate,
  createVoiceProvider,
  deletePushToken,
  deploymentAutoReviewDefault,
  destroyBot,
  displayBotWorkspacePath,
  type EncryptedSecretStore,
  enqueueTakeoverContinuation,
  expireComputerControl,
  hasActiveComputerControl,
  isAutoReviewCheckerConfigured,
  isComputerScreenUnavailable,
  isSandboxGoneError,
  isScratchpadStatus,
  listPiCatalog,
  listScratchpadItems,
  McpOAuthBroker,
  type MemoryProviderResolver,
  mapScratchpadItem,
  modelCredentialDto,
  type PiOAuthLogins,
  planLiveConnectionSync,
  prepareApiInstall,
  prepareMemoryProviderConnection,
  probeOpenAiCompatibleModels,
  provisionComputer,
  type RemoteConnectorDependencies,
  releaseComputerExecutionLease,
  replaceComputer,
  resolveAutoReviewChecker,
  resolveBotWorkspacePath,
  sanitizeComposioError,
  savePushToken,
  scheduleComputerControlExpiry,
  scheduleComputerSleep,
  screenLeaseIdForRun,
  scriptedCatalogEntry,
  serializeModelSecret,
  takeoverLeaseMs,
  toComputerRef,
  toStringRecord,
  touchRunningComputer,
  verifyMcpInstall,
} from "@rakazo/adapters";
import type { Auth } from "@rakazo/auth";
import {
  type Actor,
  appContract,
  type ComputerStatus,
  type McpServer,
  type Me,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  type SpaceNavigation,
} from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  AttachmentValidationError,
  containsSecret,
  expandSkillReferencesInPrompt,
  hasMixedOneShotSchedule,
  isOneShotRoutineCrons,
  nextCronDateAcrossStrict,
  screenLeaseId,
} from "@rakazo/core";
import {
  appendEventInTransaction,
  createGroupRepos,
  createRepos,
  createSpaceForMember,
  createThreadMessageInTransaction,
  deleteUnreferencedCredentialSecret,
  findDefaultModelCredential,
  findDefaultVoiceCredential,
  findModelCredential,
  findSpaceMemoryConfig,
  formatMessagingLinkCode,
  InvalidSpaceNameError,
  IsolationError,
  issueMessagingLinkCode,
  lockOwnedGroup,
  newestModelCredentialOrder,
  newestVoiceCredentialOrder,
  Prisma,
  type PrismaClient,
  parseComputerMode,
  SpaceLimitError,
  selectSpaceModelPreference,
  selectSpaceVoicePreference,
  type ThreadEvents,
  touchGroupUpdatedAt,
} from "@rakazo/db";
import { createAgentSkillsService } from "./agent-skills.js";
import { createOwnedArtifact, getOwnedArtifact, getSpaceArtifact } from "./artifacts.js";
import {
  executionBlocksUserTakeover,
  resolveBusyBotName,
  toComputerStatus,
} from "./computer-status.js";
import { buildMcpUpdateMaterial } from "./mcp-material.js";
import { chooseFocus, markAppConnected, startOnboarding } from "./onboarding.js";
import { listSpaceRuns } from "./runs.js";
import { addScreenProxyCapability } from "./screen-proxy.js";
import { querySpaceSearch } from "./search.js";
import { withSerializableRetry } from "./serializable-retry.js";
import {
  applyServerUpdate,
  checkServerUpdate,
  readServerUpdateStatus,
  type UpdaterProxyConfig,
  UpdaterProxyError,
} from "./server-update.js";
import { assertTeachingSendAllowed, createTaughtSkillsService } from "./taught-skills.js";
import { isPeerRun, loadAllMessages, loadMessagePage } from "./thread-message-pages.js";
import {
  reactToThreadMessage,
  resolveThreadTarget,
  sendThreadMessage,
  setThreadUnreadState,
  stopThreadRuns,
  threadHead,
  threadSnapshot,
} from "./thread-target.js";
import {
  listVoiceCatalog,
  loadDefaultVoiceCredential,
  loadVoiceCredential,
  persistVoiceCredential,
  prepareVoice,
  toVoiceCredential,
  toVoiceStatus,
  voiceContext,
} from "./voice.js";

const MAX_COMPUTER_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const THREAD_MESSAGE_PAGE_SIZE = 100;
const EXPORT_MESSAGE_PAGE_SIZE = 500;

async function reconcilePendingConnections(
  prisma: PrismaClient,
  owner: Pick<Actor, "spaceId" | "userId">,
  connectorId: string,
  connectedProviders: string[],
): Promise<void> {
  const connectedProviderKeys = new Set(
    connectedProviders.map((provider) => provider.trim().toLowerCase()),
  );
  const rows = (
    await prisma.connection.findMany({
      where: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        connectorId,
        status: { in: ["pending", "connected"] },
      },
      select: { id: true, provider: true, displayName: true, status: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
  ).filter((row: { provider: string }) =>
    connectedProviderKeys.has(row.provider.trim().toLowerCase()),
  );
  const sync = planLiveConnectionSync(rows, connectedProviders);
  const updates = [
    ...(sync.connectIds.length > 0
      ? [
          prisma.connection.updateMany({
            where: {
              id: { in: sync.connectIds },
              spaceId: owner.spaceId,
              userId: owner.userId,
              status: "pending",
            },
            data: { status: "connected" },
          }),
        ]
      : []),
    ...(sync.revokeIds.length > 0
      ? [
          prisma.connection.updateMany({
            where: {
              id: { in: sync.revokeIds },
              spaceId: owner.spaceId,
              userId: owner.userId,
              status: "pending",
            },
            data: { status: "revoked" },
          }),
        ]
      : []),
  ];
  if (updates.length > 0) await prisma.$transaction(updates);
}

function computerContext(actor: Actor, botId: string, operationId: string): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId,
    signal: new AbortController().signal,
  };
}

function mcpServerDto(
  row: {
    id: string;
    spaceId: string;
    slug: string;
    name: string;
    description: string;
    transport: string;
    endpoint: string | null;
    command: string | null;
    args: unknown;
    env: unknown;
    headers: unknown;
    secretId: string | null;
    enabled: boolean;
    revision: number;
    createdAt: Date;
    updatedAt: Date;
  },
  oauthStatus: McpServer["oauthStatus"] = "none",
): McpServer {
  const args = Array.isArray(row.args)
    ? row.args.filter((item): item is string => typeof item === "string")
    : [];
  const envKeys =
    row.env && typeof row.env === "object" && !Array.isArray(row.env) ? Object.keys(row.env) : [];
  const headerKeys =
    row.headers && typeof row.headers === "object" && !Array.isArray(row.headers)
      ? Object.keys(row.headers)
      : [];
  return {
    id: row.id,
    spaceId: row.spaceId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    transport: row.transport as McpServer["transport"],
    endpoint: row.endpoint,
    command: row.command,
    args,
    envKeys,
    headerKeys,
    hasSecret: row.secretId !== null,
    oauthStatus,
    enabled: row.enabled,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function connectionContext(
  actor: Pick<Actor, "spaceId" | "userId">,
  operationId: string,
  signal?: AbortSignal,
): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: signal ?? new AbortController().signal,
  };
}

function mcpAssignmentDto(row: {
  id: string;
  botId: string;
  serverId: string;
  allowAllTools: boolean;
  allowedTools: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    botId: row.botId,
    serverId: row.serverId,
    allowAllTools: row.allowAllTools,
    allowedTools: Array.isArray(row.allowedTools)
      ? row.allowedTools.filter((item): item is string => typeof item === "string")
      : [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface RouterDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  auth: Auth;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
  memory: MemoryStore;
  memoryProviders: MemoryProviderResolver;
  home: AgentHomeStore;
  secrets: EncryptedSecretStore;
  oauthLogins: PiOAuthLogins;
  composio?: ComposioProvider;
  mcpOAuth?: McpOAuthBroker;
  connectors: ConnectorRegistry;
  remoteConnectors?: RemoteConnectorDependencies;
  artifacts: ArtifactStore;
  dataDir: string;
  /** Present when the external messaging surface is enabled. */
  messaging?: { enabled: boolean; providers: string[]; openSignup: boolean };
  env: {
    agentRuntime: string;
    defaultProvider: string;
    defaultModel: string;
    deploymentModelKey?: string;
    webOrigin: string;
    screenProxySecret: string;
    sandboxProvider: string;
    gitSha?: string;
    updaterUrl?: string;
    updaterToken?: string;
    imageTag?: string;
  };
}

export function createRouter(deps: RouterDeps) {
  const os = implement(appContract).$context<{ actor: Actor | null; signal?: AbortSignal }>();
  const repos = createRepos(deps.prisma);
  const mcpOAuth = deps.mcpOAuth ?? new McpOAuthBroker(deps.prisma, deps.secrets);
  const groupRepos = createGroupRepos(deps.prisma);
  const taughtSkills = createTaughtSkillsService({
    prisma: deps.prisma,
    events: deps.events,
    jobs: deps.jobs,
    sandbox: deps.sandbox,
    home: deps.home,
    dataDir: deps.dataDir,
  });
  const agentSkills = createAgentSkillsService(deps.prisma);

  const authed = os.use(async ({ context, next }) => {
    if (!context.actor) throw new ORPCError("UNAUTHORIZED");
    return next({ context: { ...context, actor: context.actor } });
  });

  return os.router({
    health: os.health.handler(async () => ({ ok: true as const, version: "0.1.0" })),
    me: authed.me.handler(async ({ context }): Promise<Me> => meDto(deps, context.actor)),
    preferences: {
      update: authed.preferences.update.handler(async ({ context, input }): Promise<Me> => {
        await deps.prisma.user.update({
          where: { id: context.actor.userId },
          data: { avatarStyle: input.avatarStyle },
        });
        return meDto(deps, context.actor);
      }),
    },
    spaces: {
      list: authed.spaces.list.handler(async ({ context }) =>
        spaceNavigationDto(deps, context.actor, repos, groupRepos),
      ),
      create: authed.spaces.create.handler(async ({ context, input }) => {
        let space: { id: string; name: string };
        try {
          space = await createSpaceForMember(deps.prisma, {
            currentSpaceId: context.actor.spaceId,
            userId: context.actor.userId,
            name: input.name,
          });
        } catch (error) {
          if (error instanceof SpaceLimitError || error instanceof InvalidSpaceNameError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
        return {
          id: space.id,
          name: space.name,
          isDefault: false,
          bots: [],
          groups: [],
          botSections: [],
        };
      }),
    },
    bootstrap: authed.bootstrap.handler(async ({ context, input }) => {
      const actor = context.actor;
      const [me, navigation, archivedBots, archivedGroups] = await Promise.all([
        meDto(deps, actor),
        spaceNavigationDto(deps, actor, repos, groupRepos),
        repos.listBots(actor, { archived: true }),
        groupRepos.listGroups(actor, { archived: true }),
      ]);
      const { bots, groups, botSections } = navigation.current;
      const active = bots.find((bot) => bot.id === input.botId) ?? bots[0];
      const [thread, routines] = active
        ? await Promise.all([
            resolveThreadTarget(deps.prisma, actor, { botId: active.id }).then((target) =>
              threadSnapshot(deps, target),
            ),
            listRoutinesDto(deps, actor, active.id),
          ])
        : [null, []];
      return {
        me,
        bots,
        groups,
        botSections,
        archivedBots,
        archivedGroups,
        thread,
        routines,
        spaces: navigation.spaces,
      };
    }),
    deployment: {
      get: authed.deployment.get.handler(async ({ context }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        return deploymentDto(deps.prisma, deps.env.sandboxProvider);
      }),
      update: authed.deployment.update.handler(async ({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        if (input.computerHost === "this-mac" && deps.env.sandboxProvider !== "docker") {
          throw new ORPCError("BAD_REQUEST", {
            message:
              "This Mac mode is only available when SANDBOX_PROVIDER=docker on a personal local app.",
          });
        }
        await deps.prisma.deploymentSettings.upsert({
          where: { id: "default" },
          create: {
            id: "default",
            ownerUserId: context.actor.userId,
            signupsEnabled: input.signupsEnabled ?? true,
            signupAllowlist: (input.signupAllowlist ?? []).join(","),
            signupPolicyInitialized: true,
            computerHost: input.computerHost ?? undefined,
          },
          update: {
            ...(input.signupsEnabled === undefined ? {} : { signupsEnabled: input.signupsEnabled }),
            ...(input.signupAllowlist ? { signupAllowlist: input.signupAllowlist.join(",") } : {}),
            ...(input.signupsEnabled === undefined && input.signupAllowlist === undefined
              ? {}
              : { signupPolicyInitialized: true }),
            ...(input.computerHost === undefined ? {} : { computerHost: input.computerHost }),
          },
        });
        return deploymentDto(deps.prisma, deps.env.sandboxProvider);
      }),
    },
    updater: {
      status: authed.updater.status.handler(async ({ context }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        return readServerUpdateStatus(updaterConfig(deps));
      }),
      check: authed.updater.check.handler(async ({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        try {
          return await checkServerUpdate(updaterConfig(deps), input);
        } catch (error) {
          mapUpdaterError(error);
        }
      }),
      apply: authed.updater.apply.handler(async ({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        try {
          return await applyServerUpdate(updaterConfig(deps), input);
        } catch (error) {
          mapUpdaterError(error);
        }
      }),
    },
    models: {
      list: authed.models.list.handler(async () => [...listPiCatalog(), scriptedCatalogEntry]),
      credentials: authed.models.credentials.handler(async ({ context }) => {
        const rows = await deps.prisma.userModelCredential.findMany({
          where: { userId: context.actor.userId },
          include: {
            preferences: {
              where: { userId: context.actor.userId, spaceId: context.actor.spaceId },
            },
          },
          orderBy: newestModelCredentialOrder,
        });
        const compatibleRows = rows.filter((row) => row.provider === OPENAI_COMPATIBLE_PROVIDER_ID);
        const secrets = compatibleRows.length
          ? await deps.prisma.secret.findMany({
              where: {
                id: { in: compatibleRows.map((row) => row.secretId) },
                userId: context.actor.userId,
                spaceId: null,
              },
              select: { id: true, ciphertext: true },
            })
          : [];
        const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
        return rows.map((row) => {
          const preference = row.preferences[0];
          const selected = {
            ...row,
            isDefault: preference?.isDefault ?? false,
            defaultModel: preference?.modelId ?? null,
          };
          const ciphertext = ciphertextById.get(row.secretId);
          if (!ciphertext) return modelCredentialDto(selected);
          try {
            return modelCredentialDto(selected, deps.secrets.load(ciphertext, row.secretId));
          } catch {
            return modelCredentialDto(selected);
          }
        });
      }),
      connect: authed.models.connect.handler(async ({ context, input }) => {
        let plaintext: string;
        try {
          plaintext = buildModelConnectPlaintext(input);
        } catch (error) {
          throw new ORPCError("BAD_REQUEST", {
            message: error instanceof Error ? error.message : "Invalid model connection",
          });
        }
        return persistModelCredential(deps, context.actor, {
          provider: input.provider,
          plaintext,
          label: input.label,
          modelId: input.modelId,
          signal: context.signal,
        });
      }),
      probeOpenAiCompatible: authed.models.probeOpenAiCompatible.handler(
        async ({ context, input }) => {
          try {
            const models = await probeOpenAiCompatibleModels(input, fetch, context.signal);
            return { models };
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not list models",
            });
          }
        },
      ),
      beginOAuth: authed.models.beginOAuth.handler(async ({ context, input }) => {
        return deps.oauthLogins.begin({
          userId: context.actor.userId,
          spaceId: context.actor.spaceId,
          provider: input.provider,
          modelId: input.modelId,
          label: input.label,
          signal: context.signal,
        });
      }),
      submitOAuthCode: authed.models.submitOAuthCode.handler(async ({ context, input }) => {
        return deps.oauthLogins.submit(input.loginId, context.actor, input.code);
      }),
      completeOAuth: authed.models.completeOAuth.handler(async ({ context, input }) => {
        const result = await deps.oauthLogins.complete(input.loginId, {
          userId: context.actor.userId,
          spaceId: context.actor.spaceId,
        });
        return result.status === "connected" ? { status: "ready" as const } : result;
      }),
      finishOAuth: authed.models.finishOAuth.handler(async ({ context, input }) => {
        throwIfAborted(context.signal);
        const result = await deps.oauthLogins.finish(
          input.loginId,
          context.actor,
          async (login) => {
            return persistModelCredential(deps, context.actor, {
              provider: login.provider,
              plaintext: serializeModelSecret({ kind: "oauth", credential: login.credential }),
              label: login.label ?? "ChatGPT Plus/Pro",
              modelId: login.modelId,
              signal: login.signal,
            });
          },
        );
        if (result.status === "pending") {
          throw new ORPCError("CONFLICT", { message: "Sign-in has not finished yet." });
        }
        if (result.status === "error") {
          throw new ORPCError("NOT_FOUND", { message: result.error });
        }
        return result.value;
      }),
      cancelOAuth: authed.models.cancelOAuth.handler(async ({ context, input }) => {
        await deps.oauthLogins.cancel(input.loginId, context.actor);
        return { ok: true as const };
      }),
      setDefault: authed.models.setDefault.handler(async ({ context, input }) => {
        await withSerializableRetry(() =>
          deps.prisma.$transaction(
            async (tx) => {
              const credential = await tx.userModelCredential.findFirst({
                where: { userId: context.actor.userId, provider: input.provider },
                orderBy: newestModelCredentialOrder,
              });
              if (!credential) {
                throw new ORPCError("NOT_FOUND", {
                  message: `No model credential is connected for ${input.provider}.`,
                });
              }
              await selectSpaceModelPreference(tx, context.actor, credential.id, input.modelId);
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        );
        return { ok: true as const };
      }),
    },
    bots: {
      list: authed.bots.list.handler(async ({ context }) => repos.listBots(context.actor)),
      listArchived: authed.bots.listArchived.handler(async ({ context }) =>
        repos.listBots(context.actor, { archived: true }),
      ),
      get: authed.bots.get.handler(async ({ context, input }) => {
        const found = (await repos.listBots(context.actor)).find((bot) => bot.id === input.botId);
        if (!found) throw new IsolationError();
        return found;
      }),
      create: authed.bots.create.handler(async ({ context, input }) =>
        repos.createBot(context.actor, input),
      ),
      duplicate: authed.bots.duplicate.handler(async ({ context, input }) => {
        const source = await repos.getBot(context.actor, input.botId);
        const duplicate = await repos.createBot(context.actor, {
          name: duplicateBotName(source.name),
          title: source.title,
          description: source.description,
          instructions: source.instructions,
          notifyOnFinish: source.notifyOnFinish,
          color: source.color,
          computerMode: source.computer?.scope === "dedicated" ? "dedicated" : "team",
          modelProvider: source.modelProvider,
          modelId: source.modelId,
          thinkingLevel: source.thinkingLevel,
        });
        const assignments = await deps.prisma.botMcpServer.findMany({
          where: {
            botId: source.id,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (assignments.length) {
          await deps.prisma.botMcpServer.createMany({
            data: assignments.map((assignment) => ({
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              botId: duplicate.id,
              serverId: assignment.serverId,
              allowAllTools: assignment.allowAllTools,
              allowedTools: assignment.allowedTools as Prisma.InputJsonValue,
            })),
          });
        }
        return duplicate;
      }),
      reorder: authed.bots.reorder.handler(async ({ context, input }) => {
        await repos.reorderBots(context.actor, input.botIds);
        return { ok: true as const };
      }),
      update: authed.bots.update.handler(async ({ context, input }) => {
        const existing = await repos.getBot(context.actor, input.botId);
        if (input.sectionId) {
          const section = await deps.prisma.botSection.findFirst({
            where: {
              id: input.sectionId,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            select: { id: true },
          });
          if (!section) throw new IsolationError();
        }
        if (input.modelProvider && input.modelId) {
          const credential = await findModelCredential(
            deps.prisma,
            context.actor,
            input.modelProvider,
          );
          if (!credential) {
            throw new ORPCError("BAD_REQUEST", { message: "Connect that model provider first" });
          }
          const knownModels = [...listPiCatalog(), scriptedCatalogEntry];
          const inCatalog = knownModels.some(
            (item) => item.provider === input.modelProvider && item.id === input.modelId,
          );
          if (!inCatalog && credential.defaultModel !== input.modelId) {
            throw new ORPCError("BAD_REQUEST", { message: "Unknown model for that provider" });
          }
        }
        const thinkingLevel = input.thinkingLevel;
        if (input.thinkingLevel) {
          const provider =
            input.modelProvider !== undefined ? input.modelProvider : existing.modelProvider;
          const modelId = input.modelId !== undefined ? input.modelId : existing.modelId;
          const me = await meDto(deps, context.actor);
          const effectiveProvider = provider ?? me.defaultProvider;
          const effectiveModelId = modelId ?? me.defaultModel;
          if (effectiveProvider && effectiveModelId) {
            const entry = listPiCatalog().find(
              (item) => item.provider === effectiveProvider && item.id === effectiveModelId,
            );
            const allowed = entry?.thinkingLevels;
            if (allowed && !allowed.includes(input.thinkingLevel)) {
              throw new ORPCError("BAD_REQUEST", {
                message: `Thinking level must be one of: ${allowed.join(", ")}`,
              });
            }
          }
        }
        await deps.prisma.bot.update({
          where: { id: input.botId },
          data: {
            name: input.name,
            title: input.title,
            description: input.description,
            instructions: input.instructions,
            notifyOnFinish: input.notifyOnFinish,
            color: input.color,
            pinned: input.pinned,
            memoryScope: input.memoryScope,
            sectionId: input.sectionId,
            voiceId: input.voiceId,
            autoSpeak: input.autoSpeak,
            ...(input.modelProvider !== undefined
              ? { modelProvider: input.modelProvider, modelId: input.modelId ?? null }
              : {}),
            ...(input.thinkingLevel !== undefined ? { thinkingLevel } : {}),
          },
        });
        const bots = await repos.listBots(context.actor);
        const bot = bots.find((b) => b.id === input.botId);
        if (!bot) throw new IsolationError();
        return bot;
      }),
      setComputer: authed.bots.setComputer.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        const currentMode = bot.computer.scope === "dedicated" ? "dedicated" : "team";
        if (currentMode === input.mode) {
          return repos.setBotComputer(context.actor, bot.id, input.mode);
        }
        const claimed = await deps.prisma.bot.updateMany({
          where: { id: bot.id, computerSwitching: false },
          data: { computerSwitching: true },
        });
        if (claimed.count !== 1) throw new ORPCError("CONFLICT");
        try {
          const active = await deps.prisma.run.findFirst({
            where: { botId: bot.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
            select: { id: true },
          });
          if (active) {
            throw new ORPCError("BAD_REQUEST", { message: "Stop the bot first" });
          }
          if (bot.computer.controlBotId === bot.id && hasActiveComputerControl(bot.computer)) {
            throw new ORPCError("BAD_REQUEST", { message: "Release the computer first" });
          }
          if (bot.computer.scope === "dedicated" && bot.computer.providerRef) {
            const ctx = computerContext(context.actor, bot.id, "computer.switch");
            const ref = toComputerRef(bot.computer);
            if (bot.computer.state === "running") {
              await checkpointAndRecordComputerWorkspace(deps, bot.computer, ref, ctx);
              await deps.sandbox.stop(ref, ctx);
            }
            await deps.prisma.computerExecutionLease.deleteMany({
              where: { computerId: bot.computer.id, botId: bot.id },
            });
            await deps.prisma.computer.update({
              where: { id: bot.computer.id },
              data: {
                state: "stopped",
                controlHolder: "none",
                controlLeaseId: null,
                controlLeaseExpiresAt: null,
                controlBotId: null,
                controlRunId: null,
                executionRunId: null,
                executionBotId: null,
                executionLeaseExpiresAt: null,
              },
            });
          }
          return await repos.setBotComputer(context.actor, bot.id, input.mode);
        } finally {
          await deps.prisma.bot.updateMany({
            where: { id: bot.id },
            data: { computerSwitching: false },
          });
        }
      }),
      archive: authed.bots.archive.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId, { includeArchived: true });
        await archiveBot(
          {
            prisma: deps.prisma,
            sandbox: deps.sandbox,
            home: deps.home,
            jobs: deps.jobs,
            artifacts: deps.artifacts,
            dataDir: deps.dataDir,
          },
          bot,
          computerContext(context.actor, bot.id, "archive"),
        );
        return { ok: true as const };
      }),
      restore: authed.bots.restore.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId, { includeArchived: true });
        if (!bot.archivedAt) return { ok: true as const };
        await deps.prisma.bot.update({ where: { id: bot.id }, data: { archivedAt: null } });
        return { ok: true as const };
      }),
      remove: authed.bots.remove.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId, { includeArchived: true });
        await destroyBot(
          {
            prisma: deps.prisma,
            sandbox: deps.sandbox,
            home: deps.home,
            jobs: deps.jobs,
            artifacts: deps.artifacts,
            dataDir: deps.dataDir,
          },
          bot,
          {
            operationId: "destroy",
            traceId: "destroy",
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            signal: new AbortController().signal,
          },
          { deleteMemories: input.deleteMemories },
        );
        return { ok: true as const };
      }),
      rotateWebhookSecret: authed.bots.rotateWebhookSecret.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const plaintext = randomBytes(32).toString("base64url");
        const stored = await deps.secrets.put(plaintext, {
          operationId: "bots.rotateWebhookSecret",
          traceId: "bots.rotateWebhookSecret",
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          signal: context.signal ?? new AbortController().signal,
        });
        await deps.prisma.$transaction(async (tx) => {
          const previousSecretId = bot.webhookSecretId;
          await tx.secret.create({
            data: {
              id: stored.id,
              userId: context.actor.userId,
              spaceId: context.actor.spaceId,
              kind: "webhook",
              ciphertext: stored.ciphertext,
            },
          });
          await tx.bot.update({
            where: { id: bot.id },
            data: { webhookSecretId: stored.id },
          });
          if (previousSecretId) {
            await tx.secret.deleteMany({
              where: {
                id: previousSecretId,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                kind: "webhook",
              },
            });
          }
        });
        return {
          secret: plaintext,
          path: `/api/v1/bots/${bot.id}/webhook`,
          webhookConfigured: true as const,
        };
      }),
    },
    groups: {
      create: authed.groups.create.handler(async ({ context, input }) =>
        groupRepos.createGroup(context.actor, input),
      ),
      list: authed.groups.list.handler(async ({ context }) => groupRepos.listGroups(context.actor)),
      listArchived: authed.groups.listArchived.handler(async ({ context }) =>
        groupRepos.listGroups(context.actor, { archived: true }),
      ),
      get: authed.groups.get.handler(async ({ context, input }) => {
        const group = await groupRepos.getGroup(context.actor, input.groupId);
        return {
          ...groupRepos.mapGroup(group),
          messages: (
            await loadMessagePage(
              deps.prisma,
              group.thread!.id,
              undefined,
              THREAD_MESSAGE_PAGE_SIZE,
            )
          ).messages,
        };
      }),
      duplicate: authed.groups.duplicate.handler(async ({ context, input }) => {
        const source = await groupRepos.getGroup(context.actor, input.groupId);
        return groupRepos.createGroup(context.actor, {
          name: duplicateBotName(source.name),
          botIds: source.members.map((member) => member.bot.id),
        });
      }),
      update: authed.groups.update.handler(async ({ context, input }) => {
        if (input.sectionId) {
          const section = await deps.prisma.botSection.findFirst({
            where: {
              id: input.sectionId,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            select: { id: true },
          });
          if (!section) throw new IsolationError();
        }
        const updated = await groupRepos.updateGroup(context.actor, input);
        await Promise.all(
          updated.cancelledRunIds.map((runId) =>
            deps.jobs.cancel(runJobKey(runId)).catch(() => undefined),
          ),
        );
        return updated.group;
      }),
      archive: authed.groups.archive.handler(async ({ context, input }) => {
        const archived = await groupRepos.archiveGroup(context.actor, input.groupId);
        await Promise.all(
          archived.cancelledRunIds.map((runId) =>
            deps.jobs.cancel(runJobKey(runId)).catch(() => undefined),
          ),
        );
        await Promise.all(
          archived.computers.map(async (computer) => {
            if (!computer.providerRef || !computer.executionBotId || !computer.executionRunId) {
              return;
            }
            const adapterContext = {
              operationId: "stop",
              traceId: "stop",
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              botId: computer.executionBotId,
              runId: computer.executionRunId,
              screenLeaseId: screenLeaseIdForRun(
                { runId: computer.executionRunId, fence: computer.executionFence },
                computer.executionRunId,
              ),
              cancelRunWork: true,
              signal: new AbortController().signal,
            };
            const ref = toComputerRef(computer);
            await cancelComputerRunWork(
              deps.sandbox,
              ref,
              computer.id,
              computer.executionRunId,
              adapterContext,
            );
            await deps.sandbox.releaseScreen?.(ref, adapterContext).catch(() => undefined);
          }),
        );
        return { ok: true as const };
      }),
      restore: authed.groups.restore.handler(async ({ context, input }) => {
        await groupRepos.restoreGroup(context.actor, input.groupId);
        return { ok: true as const };
      }),
      remove: authed.groups.remove.handler(async ({ context, input }) => {
        const removed = await groupRepos.removeGroup(context.actor, input.groupId);
        const cleanup = await Promise.allSettled(
          removed.artifactStorageKeys.map((storageKey) =>
            deps.artifacts.remove(
              storageKey,
              computerContext(context.actor, removed.contextBotId, `group-remove:${input.groupId}`),
            ),
          ),
        );
        for (const result of cleanup) {
          if (result.status === "rejected") console.error("group artifact cleanup", result.reason);
        }
        return { ok: true as const };
      }),
    },
    botSections: {
      list: authed.botSections.list.handler(async ({ context }) =>
        repos.listBotSections(context.actor),
      ),
      create: authed.botSections.create.handler(async ({ context, input }) =>
        repos.createBotSection(context.actor, input),
      ),
    },
    threads: {
      head: authed.threads.head.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        return threadHead(deps.prisma, target);
      }),
      get: authed.threads.get.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        return threadSnapshot(deps, target);
      }),
      messages: authed.threads.messages.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        return loadMessagePage(
          deps.prisma,
          target.threadId,
          input.before,
          THREAD_MESSAGE_PAGE_SIZE,
          input.around,
          input.includePeerRuns,
          input.includePeerReceipts,
        );
      }),
      subscribe: authed.threads.subscribe.handler(async function* ({ context, input }) {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const peerRunCache = new Map<string, Promise<boolean>>();
        for await (const event of deps.events.follow(
          target.threadId,
          input.cursor,
          context.signal,
        )) {
          if (await isPeerRun(deps.prisma, event.runId, peerRunCache)) {
            // Keep terminal peer-run events so clients can clear working state.
            // Keep compact peer receipts for mobile; drop peer activity/replies.
            const isTerminal =
              event.type === "run.completed" ||
              event.type === "run.failed" ||
              event.type === "run.cancelled";
            const blocks = event.payload.blocks;
            const isReceipt =
              (event.type === "thread.message.created" ||
                event.type === "thread.message.updated") &&
              Array.isArray(blocks) &&
              blocks.some(
                (block) =>
                  !!block &&
                  typeof block === "object" &&
                  "kind" in block &&
                  (block.kind === "bot_message_received" || block.kind === "bot_message_sent"),
              );
            if (!isTerminal && !isReceipt) continue;
          }
          yield event;
        }
      }),
      send: authed.threads.send.handler(async ({ context, input }) => {
        if ((await modelSetup(deps, context.actor)).needsModel) {
          throw new ORPCError("BAD_REQUEST", { message: "Connect a model to start a run." });
        }
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        if (target.kind === "bot") {
          await assertTeachingSendAllowed(deps.prisma, context.actor.spaceId, target.botId);
        }
        return sendThreadMessage(deps, context.actor, target, input);
      }),
      react: authed.threads.react.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const result = await reactToThreadMessage(
          deps,
          context.actor,
          target,
          input.messageId,
          input.thumbsUp,
        );
        if (result.eventSeq != null) {
          await deps.events.notify(target.threadId, result.eventSeq).catch((error) => {
            console.error("thread reaction realtime notification", error);
          });
        }
        if (result.runId) {
          await deps.jobs.enqueue(runContinueJob(result.runId)).catch((error) => {
            console.error("thread reaction enqueue", error);
          });
        }
        return { ok: true as const };
      }),
      stop: authed.threads.stop.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        await stopThreadRuns(deps, context.actor, target);
        return { ok: true as const };
      }),
      clear: authed.threads.clear.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const contextBotId = target.kind === "bot" ? target.botId : target.memberBotIds[0];
        if (!contextBotId) throw new IsolationError();
        const { cancelledRunIds, historyCompactionGeneration } = await deps.events.clearThread({
          spaceId: context.actor.spaceId,
          threadId: target.threadId,
          botId: contextBotId,
          ...(target.kind === "group" ? { groupId: target.groupId } : {}),
        });
        const [configuredMemory] = await Promise.all([
          target.kind === "bot"
            ? deps.memoryProviders.resolve(context.actor.spaceId).catch((error) => {
                console.error("semantic memory resolution after thread clear failed", error);
                return null;
              })
            : Promise.resolve(null),
          Promise.all(
            cancelledRunIds.map((runId) =>
              deps.jobs.cancel(runJobKey(runId)).catch(() => undefined),
            ),
          ),
        ]);
        // Durable memories remain in their Space-private containers. Clear only removes
        // conversation-derived summaries from the previous generation; including the new
        // generation also covers a compaction job that began just after the clear committed.
        if (configuredMemory && target.kind === "bot") {
          // Best effort: the conversation rows are already deleted, so failing the clear here
          // would help nothing — a failed purge only leaves stale summaries recallable.
          try {
            const purged = await configuredMemory.provider.purgeHistory(
              {
                botId: target.botId,
                generations: [
                  Math.max(0, historyCompactionGeneration - 1),
                  historyCompactionGeneration,
                ],
              },
              computerContext(context.actor, target.botId, `thread-clear:${target.threadId}`),
            );
            if (!purged.ok) {
              console.error("semantic memory purge after thread clear failed", purged.error);
            }
          } catch (error) {
            console.error("semantic memory purge after thread clear failed", error);
          }
        }
        return { ok: true as const };
      }),
      followUp: authed.threads.followUp.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        if (target.kind === "bot") {
          await assertTeachingSendAllowed(deps.prisma, context.actor.spaceId, target.botId);
          const sent = await deps.events.sendUserMessage({
            spaceId: context.actor.spaceId,
            threadId: target.threadId,
            botId: target.botId,
            userId: context.actor.userId,
            blocks: [{ kind: "text", text: input.text }],
            prompt: input.text,
            trigger: "follow_up",
          });
          if (sent.taskId && sent.runId) {
            await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
              console.error("follow-up enqueue", error);
            });
          }
          return { ok: true as const };
        }
        const committed = await deps.prisma.$transaction(async (tx) => {
          await lockOwnedGroup(tx, context.actor, target.groupId);
          const group = await tx.chatGroup.findFirst({
            where: {
              id: target.groupId,
              archivedAt: null,
              thread: { id: target.threadId },
            },
            include: { members: { orderBy: { createdAt: "asc" } } },
          });
          const botId = group?.members[0]?.botId;
          if (!botId) throw new IsolationError();
          const blocks = [{ kind: "text" as const, text: input.text }];
          const message = await createThreadMessageInTransaction(tx, {
            threadId: target.threadId,
            role: "user",
            blocks,
          });
          const active = await tx.run.findFirst({
            where: {
              threadId: target.threadId,
              botId,
              status: { in: [...ACTIVE_RUN_STATUSES] },
            },
            select: { id: true },
          });
          let run: { id: string } | null = null;
          if (!active) {
            const task = await tx.task.create({
              data: {
                spaceId: context.actor.spaceId,
                botId,
                threadId: target.threadId,
                userId: context.actor.userId,
                prompt: input.text,
                status: "queued",
              },
            });
            run = await tx.run.create({
              data: {
                spaceId: context.actor.spaceId,
                botId,
                threadId: target.threadId,
                taskId: task.id,
                userId: context.actor.userId,
                status: "queued",
                trigger: "follow_up",
                sourceMessageId: message.id,
              },
              select: { id: true },
            });
            await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
          } else {
            await tx.steeringMessage.create({
              data: {
                messageId: message.id,
                botId,
                userId: context.actor.userId,
                runId: active.id,
              },
            });
            await tx.message.update({ where: { id: message.id }, data: { runId: active.id } });
          }
          const event = await appendEventInTransaction(tx, {
            spaceId: context.actor.spaceId,
            threadId: target.threadId,
            botId,
            type: "thread.message.created",
            runId: run?.id ?? active?.id,
            payload: { messageId: message.id, role: "user", blocks },
          });
          await touchGroupUpdatedAt(tx, target.groupId);
          return { runId: run?.id, eventSeq: event.seq };
        });
        await deps.events.notify(target.threadId, committed.eventSeq).catch((error) => {
          console.error("group follow-up realtime notification", error);
        });
        if (committed.runId) {
          await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
            console.error("group follow-up enqueue", error);
          });
        }
        return { ok: true as const };
      }),
      answer: authed.threads.answer.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const answered = await deps.events.answerRunInput({
          spaceId: context.actor.spaceId,
          threadId: target.threadId,
          runId: input.runId,
          messageId: input.messageId,
          answeredByUserId: context.actor.userId,
          answer: input.answer,
        });
        if (!answered) {
          throw new ORPCError("CONFLICT", {
            message: "This prompt is no longer awaiting an answer",
          });
        }
        await deps.jobs.enqueue(runContinueJob(input.runId)).catch((error) => {
          // The answer and queued run are durable; the reconciler repairs a missed immediate wake.
          console.error("thread answer enqueue", error);
        });
        return { ok: true as const };
      }),
      markRead: authed.threads.markRead.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        await setThreadUnreadState(deps.prisma, context.actor, target, false);
        return { ok: true as const };
      }),
      markUnread: authed.threads.markUnread.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        await setThreadUnreadState(deps.prisma, context.actor, target, true);
        return { ok: true as const };
      }),
    },
    computer: {
      status: authed.computer.status.handler(async ({ context, input }) =>
        computerStatus(deps, context.actor, input.botId),
      ),
      boot: authed.computer.boot.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        if (bot.computer.state === "running" && bot.computer.providerRef) {
          scheduleComputerSleep(deps.jobs, bot.computer.id);
          return computerStatus(deps, context.actor, input.botId);
        }
        const ctx = computerContext(context.actor, bot.id, "boot");
        const manualRunId = `boot:${randomUUID()}`;
        let lease: ComputerExecutionLease | null;
        try {
          lease = await acquireComputerExecutionLease(deps.prisma, {
            computerId: bot.computer.id,
            runId: manualRunId,
            botId: bot.id,
          });
        } catch (error) {
          if (error instanceof ComputerBusyError) {
            throw new ORPCError("CONFLICT", { message: "Computer is busy" });
          }
          throw error;
        }
        try {
          await provisionComputer(deps, bot.computer.id, {
            ...ctx,
            screenLeaseId: screenLeaseIdForRun(lease, manualRunId),
          });
          scheduleComputerSleep(deps.jobs, bot.computer.id);
        } finally {
          await releaseComputerExecutionLease(deps.prisma, lease);
        }
        return computerStatus(deps, context.actor, input.botId);
      }),
      stop: authed.computer.stop.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        const controlLeaseId = bot.computer.controlLeaseId;
        const now = new Date();
        const claimed = await deps.prisma.computer.updateMany({
          where: {
            id: bot.computer.id,
            state: { not: "suspending" },
            executionLeases: {
              none: { botId: { not: bot.id }, expiresAt: { gt: now } },
            },
          },
          data: { state: "suspending" },
        });
        if (claimed.count !== 1) {
          throw new ORPCError("CONFLICT", {
            message: "Other Team bots are still using this computer",
          });
        }
        const otherRun = await deps.prisma.run.findFirst({
          where: {
            botId: { not: bot.id },
            status: { in: [...ACTIVE_RUN_STATUSES] },
            bot: { computerId: bot.computer.id },
          },
          select: { id: true },
        });
        if (otherRun) {
          await deps.prisma.computer.updateMany({
            where: { id: bot.computer.id, state: "suspending" },
            data: { state: bot.computer.state },
          });
          throw new ORPCError("CONFLICT", {
            message: "Other Team bots are still using this computer",
          });
        }
        await deps.prisma.computerExecutionLease.deleteMany({
          where: { computerId: bot.computer.id, botId: bot.id },
        });
        try {
          if (bot.computer.providerRef) {
            const ctx = computerContext(context.actor, bot.id, "stop");
            const ref = toComputerRef(bot.computer);
            await checkpointAndRecordComputerWorkspace(deps, bot.computer, ref, ctx);
            await deps.sandbox.stop(ref, ctx);
          }
          await deps.prisma.computer.update({
            where: { id: bot.computer.id },
            data: {
              state: "stopped",
              controlHolder: "none",
              controlLeaseId: null,
              controlLeaseExpiresAt: null,
              controlBotId: null,
              controlRunId: null,
            },
          });
        } catch (error) {
          await deps.prisma.computer
            .updateMany({
              where: { id: bot.computer.id, state: "suspending" },
              data: { state: "error" },
            })
            .catch(() => undefined);
          throw error;
        }
        await deps.jobs.cancel(
          computerControlExpireJobKey(bot.computer.id, controlLeaseId ?? undefined),
        );
        return computerStatus(deps, context.actor, input.botId);
      }),
      recover: authed.computer.recover.handler(async ({ context, input }) =>
        runComputerReplace(deps, context, input.botId, "recover", "recover"),
      ),
      reset: authed.computer.reset.handler(async ({ context, input }) =>
        runComputerReplace(deps, context, input.botId, "reset", "reset"),
      ),
      update: authed.computer.update.handler(async ({ context, input }) =>
        runComputerReplace(deps, context, input.botId, "update", "update"),
      ),
      takeover: authed.computer.takeover.handler(async ({ context, input }) => {
        let bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer?.providerRef || bot.computer.state !== "running") {
          throw new ORPCError("BAD_REQUEST", { message: "computer must be running" });
        }
        if (hasActiveComputerControl(bot.computer) && bot.computer.controlBotId === bot.id) {
          await scheduleComputerControlExpiry(
            deps.jobs,
            bot.computer.id,
            bot.computer.controlLeaseId!,
            bot.computer.controlLeaseExpiresAt!,
          );
          return {
            leaseId: bot.computer.controlLeaseId!,
            expiresAt: bot.computer.controlLeaseExpiresAt!.toISOString(),
          };
        }
        if (hasActiveComputerControl(bot.computer) && bot.computer.controlBotId !== bot.id) {
          const previousBotId = bot.computer.controlBotId!;
          await deps.sandbox.setScreenControl?.(
            toComputerRef(bot.computer),
            false,
            computerContext(context.actor, previousBotId, "screen.release"),
            bot.computer.controlLeaseId ?? undefined,
          );
          await deps.prisma.computer.updateMany({
            where: { id: bot.computer.id, controlLeaseId: bot.computer.controlLeaseId },
            data: {
              controlHolder: "none",
              controlLeaseId: null,
              controlLeaseExpiresAt: null,
              controlBotId: null,
              controlRunId: null,
            },
          });
          bot = await repos.getBot(context.actor, input.botId);
          if (!bot.computer) throw new IsolationError();
        }
        if (bot.computer.controlLeaseId) {
          await expireComputerControl(deps, bot.computer.id, bot.computer.controlLeaseId);
          bot = await repos.getBot(context.actor, input.botId);
        }
        if (!bot.computer) throw new IsolationError();

        const executionLease = await deps.prisma.computerExecutionLease.findUnique({
          where: { computerId_botId: { computerId: bot.computer.id, botId: bot.id } },
        });
        const executionRun = executionLease
          ? await deps.prisma.run.findUnique({
              where: { id: executionLease.runId },
              select: { botId: true, status: true },
            })
          : null;
        const waitingForTakeover =
          executionRun?.botId === bot.id && executionRun.status === "waiting_takeover";
        if (
          executionBlocksUserTakeover({
            hasLease: Boolean(executionLease),
            leaseExpiresAt: executionLease?.expiresAt,
            runStatus: executionRun?.status,
          })
        ) {
          throw new ORPCError("CONFLICT", { message: "Stop the bot first" });
        }
        // Keep an inactive lease as a fencing tombstone. The next run reclaims it
        // with a higher fence, even if this user's screen remains connected.

        const leaseId = randomUUID();
        const expiresAt = new Date(Date.now() + takeoverLeaseMs());
        const granted = await deps.prisma.computer.updateMany({
          where: {
            id: bot.computer.id,
            state: "running",
            controlHolder: { not: "user" },
            controlLeaseId: null,
          },
          data: {
            controlHolder: "user",
            controlLeaseId: leaseId,
            controlLeaseExpiresAt: expiresAt,
            controlBotId: bot.id,
            controlRunId: waitingForTakeover ? executionLease?.runId : null,
            state: "running",
          },
        });
        if (granted.count !== 1) {
          const current = await deps.prisma.computer.findUniqueOrThrow({
            where: { id: bot.computer.id },
          });
          if (!hasActiveComputerControl(current)) throw new ORPCError("CONFLICT");
          await scheduleComputerControlExpiry(
            deps.jobs,
            current.id,
            current.controlLeaseId!,
            current.controlLeaseExpiresAt!,
          );
          return {
            leaseId: current.controlLeaseId!,
            expiresAt: current.controlLeaseExpiresAt!.toISOString(),
          };
        }
        try {
          await scheduleComputerControlExpiry(deps.jobs, bot.computer.id, leaseId, expiresAt);
        } catch (error) {
          await deps.prisma.computer.updateMany({
            where: { id: bot.computer.id, controlLeaseId: leaseId },
            data: {
              controlHolder: "none",
              controlLeaseId: null,
              controlLeaseExpiresAt: null,
              controlBotId: null,
              controlRunId: null,
            },
          });
          throw error;
        }
        if (bot.thread) {
          await deps.events.append({
            spaceId: context.actor.spaceId,
            threadId: bot.thread.id,
            botId: bot.id,
            type: "computer.takeover.granted",
            payload: { leaseId, takeoverRequested: waitingForTakeover },
          });
        }
        scheduleComputerSleep(deps.jobs, bot.computer.id);
        return { leaseId, expiresAt: expiresAt.toISOString() };
      }),
      release: authed.computer.release.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        const controlBotId = bot.computer.controlBotId;
        const controlLeaseId = bot.computer.controlLeaseId;
        if (bot.computer.controlHolder !== "user" || !controlBotId || controlBotId !== bot.id) {
          return { ok: true as const };
        }
        if (!hasActiveComputerControl(bot.computer) || !controlLeaseId) {
          // Stale controlHolder=user. Prefer expiry (revokes provider control). If a lease id
          // remains after a failed revoke, keep it so reconciliation can retry.
          if (controlLeaseId) {
            await expireComputerControl(deps, bot.computer.id, controlLeaseId).catch(
              () => undefined,
            );
          } else {
            await clearInactiveUserComputerControl(deps.prisma, bot.computer.id);
          }
          return { ok: true as const };
        }
        if (bot.computer.providerRef) {
          await deps.sandbox.setScreenControl?.(
            toComputerRef(bot.computer),
            false,
            computerContext(context.actor, controlBotId, "screen.release"),
            controlLeaseId,
          );
        }

        const released = await deps.events.finalizeComputerControlRelease({
          spaceId: context.actor.spaceId,
          computerId: bot.computer.id,
          botId: controlBotId,
          runId: bot.computer.controlRunId,
          leaseId: controlLeaseId,
          holder: "bot",
          reason: input.reason ?? "released",
        });
        if (!released) return { ok: true as const };
        // The lease-specific key makes this cancellation safe after a replacement takeover.
        await deps.jobs
          .cancel(computerControlExpireJobKey(bot.computer.id, controlLeaseId))
          .catch((error) => {
            // The expired job is harmless after the lease is cleared, so do not report a
            // failed release after the transaction has committed.
            console.error("computer control expiry cancellation", error);
          });

        await enqueueTakeoverContinuation(deps.jobs, released.runId);
        scheduleComputerSleep(deps.jobs, bot.computer.id);
        return { ok: true as const };
      }),
      input: authed.computer.input.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const computer = bot.computer;
        if (!computer || !hasActiveComputerControl(computer) || computer.controlBotId !== bot.id) {
          await expireStaleComputerControl(deps, computer);
          throw new ORPCError("FORBIDDEN");
        }
        if (!computer.providerRef) return { ok: true as const };
        const mapped =
          input.kind === "key"
            ? { kind: "key" as const, key: String(input.payload.key ?? "") }
            : input.kind === "clipboard"
              ? { kind: "clipboard" as const, text: String(input.payload.text ?? "") }
              : input.kind === "scroll"
                ? {
                    kind: "scroll" as const,
                    direction:
                      input.payload.direction === "up" ? ("up" as const) : ("down" as const),
                    amount: Number(input.payload.amount ?? 3),
                  }
                : {
                    kind: "pointer" as const,
                    x: Number(input.payload.x ?? 0),
                    y: Number(input.payload.y ?? 0),
                    button: (input.payload.button as "left" | "right" | undefined) ?? "left",
                    type:
                      (input.payload.type as "move" | "down" | "up" | "click" | undefined) ??
                      "click",
                  };
        const outcome = await taughtSkills.recordInput(context.actor, bot.id, mapped);
        if (outcome === "stale") return { ok: true as const };
        if (outcome !== "recorded") {
          await applyTeachingDesktopInput(
            deps.sandbox,
            computer,
            mapped,
            computerContext(context.actor, bot.id, "input"),
          );
        }
        await deps.prisma.computer.updateMany({
          where: { id: computer.id, state: "running" },
          data: { updatedAt: new Date() },
        });
        scheduleComputerSleep(deps.jobs, computer.id);
        return { ok: true as const };
      }),
      files: authed.computer.files.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        const computer = bot.computer;
        const computerMode = parseComputerMode(computer.scope);
        const ctx = computerContext(context.actor, bot.id, "files");
        const storedPath = resolveBotWorkspacePath(computerMode, bot.id, input.path);
        let entries: Awaited<ReturnType<SandboxProvider["listFiles"]>>;
        if (computer.state === "running" && computer.providerRef) {
          await deps.prisma.computer.updateMany({
            where: { id: computer.id, state: "running" },
            data: { updatedAt: new Date() },
          });
          scheduleComputerSleep(deps.jobs, computer.id);
          entries = await deps.sandbox.listFiles(toComputerRef(computer), storedPath, ctx);
        } else {
          entries = await deps.home.list(computer.homeKey, storedPath, ctx);
        }
        return entries.map((entry) => ({
          ...entry,
          path: displayBotWorkspacePath(computerMode, bot.id, input.path, entry.path),
        }));
      }),
      readFile: authed.computer.readFile.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        const computerMode = parseComputerMode(bot.computer.scope);
        const ctx = computerContext(context.actor, bot.id, "read");
        const storedPath = resolveBotWorkspacePath(computerMode, bot.id, input.path);
        let content: string;
        if (bot.computer.state === "running" && bot.computer.providerRef) {
          await deps.prisma.computer.updateMany({
            where: { id: bot.computer.id, state: "running" },
            data: { updatedAt: new Date() },
          });
          scheduleComputerSleep(deps.jobs, bot.computer.id);
          const bytes = await deps.sandbox.readFile(toComputerRef(bot.computer), storedPath, ctx, {
            maxBytes: MAX_COMPUTER_TEXT_FILE_BYTES,
          });
          content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } else {
          try {
            content = await deps.home.readFile(bot.computer.homeKey, storedPath, ctx, {
              maxBytes: MAX_COMPUTER_TEXT_FILE_BYTES,
            });
          } catch (error) {
            if (error instanceof Error && error.message.startsWith("agent home file exceeds ")) {
              throw new ORPCError("BAD_REQUEST", { message: "file is too large to preview" });
            }
            throw error;
          }
        }
        return { path: input.path, content };
      }),
      screenUrl: authed.computer.screenUrl.handler(async ({ context, input }) => {
        let bot = await repos.getBot(context.actor, input.botId);
        if (await expireStaleComputerControl(deps, bot.computer)) {
          bot = await repos.getBot(context.actor, input.botId);
        }
        if (
          !bot.computer?.providerRef ||
          (bot.computer.state !== "running" && bot.computer.state !== "booting")
        ) {
          return { url: null };
        }
        const computer = bot.computer;
        const session = await deps.sandbox
          .connectScreen(
            toComputerRef(computer),
            {
              view: "stream",
              interactive: hasActiveComputerControl(computer) && computer.controlBotId === bot.id,
              controlToken:
                computer.controlBotId === bot.id
                  ? (computer.controlLeaseId ?? undefined)
                  : undefined,
            },
            await computerScreenContext(deps.prisma, context.actor, computer.id, bot.id, "screen"),
          )
          .catch(async (error: unknown) => {
            if (isComputerScreenUnavailable(error)) {
              throw new ORPCError("CONFLICT", { message: error.message });
            }
            if (!isSandboxGoneError(error)) throw error;
            // The provider killed this sandbox (idle timeout) while the row still says
            // running. Clear the dead ref so the UI offers a boot instead of 500ing.
            // Leave any active control lease alone — expireComputerControl owns that
            // release (provider screen-control, events, takeover continuation).
            console.error(`computer ${computer.id} sandbox ${computer.providerRef} is gone`, error);
            await deps.prisma.computer.updateMany({
              where: { id: computer.id, providerRef: computer.providerRef },
              data: { state: "stopped", providerRef: null },
            });
            return null;
          });
        if (!session?.url) return { url: null };
        scheduleComputerSleep(deps.jobs, bot.computer.id);
        const viewUrl = withViewOnly(
          session.url,
          !(hasActiveComputerControl(bot.computer) && bot.computer.controlBotId === bot.id),
        );
        return {
          url: addScreenProxyCapability(
            viewUrl,
            deps.env.screenProxySecret,
            deps.env.webOrigin,
            undefined,
            { proxyExternal: bot.computer.kind === "box" },
          ),
        };
      }),
      screenClose: authed.computer.screenClose.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const computer = bot.computer;
        if (
          !computer?.providerRef ||
          (computer.state !== "running" && computer.state !== "booting")
        ) {
          return { ok: true as const };
        }
        await deps.sandbox.releaseScreen?.(toComputerRef(computer), {
          ...computerContext(context.actor, bot.id, "screen.close"),
          // A viewer lease can release an idle viewer allocation, but cannot
          // release a newer fenced run that claimed this bot's screen.
          screenLeaseId: screenViewerLeaseId(bot.id),
          // Closing a user-controlled view keeps the lease, but its quiesced
          // browser state is still authoritative for shared sign-ins.
          authoritativeBrowserState:
            computer.controlHolder === "user" && computer.controlBotId === bot.id,
        });
        scheduleComputerSleep(deps.jobs, computer.id);
        return { ok: true as const };
      }),
      heartbeat: authed.computer.heartbeat.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (bot.computer?.state === "running" && bot.computer.providerRef) {
          await deps.prisma.computer.updateMany({
            where: { id: bot.computer.id, state: "running" },
            data: { updatedAt: new Date() },
          });
          await touchRunningComputer(
            { sandbox: deps.sandbox, jobs: deps.jobs },
            {
              id: bot.computer.id,
              homeKey: bot.computer.homeKey,
              providerRef: bot.computer.providerRef,
              kind: bot.computer.kind,
            },
          ).catch(() => undefined);
        }
        return { ok: true as const };
      }),
    },
    memory: {
      list: authed.memory.list.handler(async ({ context, input }) => {
        const docs = await deps.prisma.memoryDocument.findMany({
          where: {
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            ...(input.botId ? { botId: input.botId } : {}),
            ...(input.scope ? { scope: input.scope } : {}),
          },
        });
        return docs.map((doc) => ({
          id: doc.id,
          scope: doc.scope as "bot" | "user",
          botId: doc.botId,
          path: doc.path,
          content: doc.content,
          revision: doc.revision,
          updatedAt: doc.updatedAt.toISOString(),
        }));
      }),
      update: authed.memory.update.handler(async ({ context, input }) => {
        const doc = await deps.prisma.memoryDocument.findFirst({
          where: {
            id: input.documentId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!doc) throw new IsolationError();
        const updated = await deps.memory.commit(
          {
            scope: doc.scope as "bot" | "user",
            botId: doc.botId ?? undefined,
            path: doc.path,
            content: input.content,
          },
          {
            operationId: "mem",
            traceId: "mem",
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            signal: new AbortController().signal,
          },
        );
        return {
          id: updated.id,
          scope: doc.scope as "bot" | "user",
          botId: doc.botId,
          path: updated.path,
          content: updated.content,
          revision: updated.revision,
          updatedAt: new Date().toISOString(),
        };
      }),
      exportMarkdown: authed.memory.exportMarkdown.handler(async ({ context, input }) => {
        const docs = await deps.prisma.memoryDocument.findMany({
          where: {
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            ...(input.botId ? { botId: input.botId } : {}),
          },
        });
        return docs.map((d) => `# ${d.path}\n\n${d.content}`).join("\n\n");
      }),
      providerConfig: authed.memory.providerConfig.handler(async ({ context }) => {
        const config = await findSpaceMemoryConfig(deps.prisma, context.actor.spaceId);
        return config ? serializeSpaceMemoryConfig(config) : null;
      }),
      connectProvider: authed.memory.connectProvider.handler(async ({ context, input }) =>
        persistMemoryProviderConfig(deps, context.actor, input),
      ),
      setDefaultScope: authed.memory.setDefaultScope.handler(async ({ context, input }) =>
        updateMemoryProviderDefaultScope(deps, context.actor, input.defaultMemoryScope),
      ),
      disconnectProvider: authed.memory.disconnectProvider.handler(async ({ context }) => {
        await requireSpaceOwner(deps.prisma, context.actor);
        await withSerializableRetry(() =>
          deps.prisma.$transaction(
            async (tx) => {
              const existing = await findSpaceMemoryConfig(tx, context.actor.spaceId);
              if (!existing) return;
              await tx.spaceMemoryConfig.delete({ where: { id: existing.id } });
              await tx.secret.deleteMany({ where: { id: existing.secretId } });
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        );
        return { ok: true as const };
      }),
    },
    routines: {
      list: authed.routines.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return listRoutinesDto(deps, context.actor, input.botId);
      }),
      create: authed.routines.create.handler(async ({ context, input }) => {
        if (hasMixedOneShotSchedule(input.crons)) {
          throw new ORPCError("BAD_REQUEST", {
            message: "A one-time schedule can't be combined with other schedules.",
          });
        }
        if (input.active && isOneShotRoutineCrons(input.crons)) {
          throw new ORPCError("BAD_REQUEST", {
            message: "One-shot schedules must be created from chat.",
          });
        }
        const bot = await repos.getBot(context.actor, input.botId);
        // Validate every recurring cron even when inactive; @once and webhook-only have no next date.
        let nextRunAt: Date | null = null;
        if (input.crons.length > 0 && !isOneShotRoutineCrons(input.crons)) {
          const computedNextRunAt = nextRoutineDate(input.crons, input.timezone);
          nextRunAt = input.active ? computedNextRunAt : null;
        }
        const row = await deps.prisma.routine.create({
          data: {
            spaceId: context.actor.spaceId,
            botId: input.botId,
            userId: context.actor.userId,
            name: input.name,
            prompt: input.prompt,
            crons: input.crons,
            timezone: input.timezone,
            notify: input.notify,
            active: input.active,
            webhookEnabled: input.webhookEnabled,
            nextRunAt,
          },
        });
        if (bot.thread) {
          await deps.events.append({
            spaceId: context.actor.spaceId,
            threadId: bot.thread.id,
            botId: bot.id,
            type: "routine.created",
            payload: { name: row.name },
          });
        }
        if (row.active && row.nextRunAt) {
          await deps.jobs.enqueue(routineWakeupJob(row.id, row.nextRunAt));
        }
        return mapRoutine(row);
      }),
      update: authed.routines.update.handler(async ({ context, input }) => {
        const existing = await deps.prisma.routine.findFirst({
          where: {
            id: input.routineId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!existing) throw new IsolationError();
        const active = input.active ?? existing.active;
        const crons = input.crons ?? existing.crons;
        const timezone = input.timezone ?? existing.timezone;
        const webhookEnabled = input.webhookEnabled ?? existing.webhookEnabled;
        if (crons.length === 0 && !webhookEnabled) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Add a schedule or webhook trigger",
          });
        }
        if (hasMixedOneShotSchedule(crons)) {
          throw new ORPCError("BAD_REQUEST", {
            message: "A one-time schedule can't be combined with other schedules.",
          });
        }
        if (active && isOneShotRoutineCrons(crons)) {
          if (!isOneShotRoutineCrons(existing.crons)) {
            throw new ORPCError("BAD_REQUEST", {
              message: "One-shot schedules must be created from chat.",
            });
          }
          if (!existing.nextRunAt && existing.lastRunAt) {
            throw new ORPCError("BAD_REQUEST", {
              message: "This one-shot already ran.",
            });
          }
        }
        const scheduleChanged =
          (!existing.active && active) ||
          (input.crons !== undefined &&
            JSON.stringify(input.crons) !== JSON.stringify(existing.crons)) ||
          (input.timezone !== undefined && input.timezone !== existing.timezone);
        const recalculatedNextRunAt =
          crons.length > 0 &&
          !isOneShotRoutineCrons(crons) &&
          (scheduleChanged || (active && !existing.nextRunAt))
            ? nextRoutineDate(crons, timezone)
            : null;
        let armedOneShotAt: Date | null = null;
        if (active && isOneShotRoutineCrons(crons) && !existing.nextRunAt && !existing.lastRunAt) {
          if (!input.runAt) {
            throw new ORPCError("BAD_REQUEST", {
              message: "Add a run time for this one-shot.",
            });
          }
          const parsed = new Date(input.runAt);
          if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) {
            throw new ORPCError("BAD_REQUEST", {
              message: "Run time must be in the future.",
            });
          }
          armedOneShotAt = parsed;
        } else if (input.runAt !== undefined) {
          throw new ORPCError("BAD_REQUEST", {
            message: "A run time is only for one-shots that have not run yet.",
          });
        }
        const nextRunAt = !active
          ? null
          : crons.length === 0
            ? null
            : isOneShotRoutineCrons(crons)
              ? (armedOneShotAt ?? existing.nextRunAt)
              : (recalculatedNextRunAt ?? existing.nextRunAt);
        const row = await deps.prisma.routine.update({
          where: { id: existing.id },
          data: {
            name: input.name,
            prompt: input.prompt,
            crons: input.crons,
            timezone: input.timezone,
            active: input.active,
            notify: input.notify,
            webhookEnabled: input.webhookEnabled,
            nextRunAt,
          },
        });
        const bot = await repos.getBot(context.actor, row.botId);
        if (bot.thread) {
          await deps.events.append({
            spaceId: context.actor.spaceId,
            threadId: bot.thread.id,
            botId: bot.id,
            type: "routine.updated",
            payload: { routineId: row.id, active: row.active },
          });
        }
        const scheduleNeedsSync =
          existing.active !== row.active ||
          scheduleChanged ||
          (!existing.nextRunAt && !!row.nextRunAt);
        if (scheduleNeedsSync) {
          if (row.active && row.nextRunAt) {
            await deps.jobs.enqueue(routineWakeupJob(row.id, row.nextRunAt));
          } else {
            await deps.jobs.cancel(routineJobKey(row.id));
          }
        }
        return mapRoutine(row);
      }),
      remove: authed.routines.remove.handler(async ({ context, input }) => {
        const existing = await deps.prisma.routine.findFirst({
          where: { id: input.routineId, spaceId: context.actor.spaceId },
        });
        if (!existing) throw new IsolationError();
        await deps.prisma.routine.delete({ where: { id: existing.id } });
        await deps.jobs.cancel(routineJobKey(existing.id));
        return { ok: true as const };
      }),
      testRun: authed.routines.testRun.handler(async ({ context, input }) => {
        const routine = await deps.prisma.routine.findFirst({
          where: {
            id: input.routineId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!routine) throw new IsolationError();
        const bot = await repos.getBot(context.actor, routine.botId);
        if (!bot.thread) throw new IsolationError();
        const threadId = bot.thread.id;
        const nonce = input.clientNonce ? `routine-test:${input.clientNonce}` : undefined;
        if (nonce) {
          const existing = await deps.prisma.run.findFirst({
            where: { threadId, clientNonce: nonce },
            select: { id: true },
          });
          if (existing) return { runId: existing.id };
        }
        const skillRecords = await agentSkills.listWithContent(context.actor);
        const prompt = expandSkillReferencesInPrompt(routine.prompt, skillRecords);
        let run: { id: string };
        try {
          // Task + run must commit together so a nonce collision cannot leave an orphan queued Task.
          run = await deps.prisma.$transaction(async (tx) => {
            if (nonce) {
              const existing = await tx.run.findFirst({
                where: { threadId, clientNonce: nonce },
                select: { id: true },
              });
              if (existing) return existing;
            }
            const task = await tx.task.create({
              data: {
                spaceId: context.actor.spaceId,
                botId: bot.id,
                threadId,
                userId: context.actor.userId,
                prompt,
                status: "queued",
              },
            });
            return tx.run.create({
              data: {
                spaceId: context.actor.spaceId,
                botId: bot.id,
                threadId,
                taskId: task.id,
                userId: context.actor.userId,
                status: "queued",
                trigger: "routine",
                routineId: routine.id,
                clientNonce: nonce,
              },
              select: { id: true },
            });
          });
        } catch (error) {
          if (nonce) {
            const existing = await deps.prisma.run.findFirst({
              where: { threadId, clientNonce: nonce },
              select: { id: true },
            });
            if (existing) return { runId: existing.id };
          }
          throw error;
        }
        // Keep enqueue outside the nonce-collision catch. The queued run is durable;
        // log enqueue failures and still return success — the reconciler repairs a missed wake.
        await deps.jobs.enqueue(runContinueJob(run.id)).catch((error) => {
          console.error("routine testRun enqueue", error);
        });
        return { runId: run.id };
      }),
    },
    scratchpad: {
      list: authed.scratchpad.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return listScratchpadItems(
          { prisma: deps.prisma },
          {
            spaceId: context.actor.spaceId,
            botId: input.botId,
            status: input.status,
            includeDone: input.includeDone ?? false,
          },
        );
      }),
      create: authed.scratchpad.create.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        const row = await deps.prisma.scratchpadItem.create({
          data: {
            spaceId: context.actor.spaceId,
            botId: input.botId,
            userId: context.actor.userId,
            title: input.title.trim(),
            status: input.status,
            notes: input.notes.trim(),
          },
        });
        return mapScratchpadItem(row);
      }),
      update: authed.scratchpad.update.handler(async ({ context, input }) => {
        const existing = await deps.prisma.scratchpadItem.findFirst({
          where: {
            id: input.itemId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!existing) throw new IsolationError();
        if (input.status !== undefined && !isScratchpadStatus(input.status)) {
          throw new ORPCError("BAD_REQUEST", { message: "Invalid scratchpad status." });
        }
        const row = await deps.prisma.scratchpadItem.update({
          where: { id: existing.id },
          data: {
            ...(input.title !== undefined ? { title: input.title.trim() } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.notes !== undefined ? { notes: input.notes.trim() } : {}),
          },
        });
        return mapScratchpadItem(row);
      }),
      remove: authed.scratchpad.remove.handler(async ({ context, input }) => {
        const existing = await deps.prisma.scratchpadItem.findFirst({
          where: {
            id: input.itemId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!existing) throw new IsolationError();
        await deps.prisma.scratchpadItem.delete({ where: { id: existing.id } });
        return { ok: true as const };
      }),
    },
    skills: {
      list: authed.skills.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return taughtSkills.list(context.actor, input.botId);
      }),
      get: authed.skills.get.handler(async ({ context, input }) =>
        taughtSkills.get(context.actor, input.skillId),
      ),
      start: authed.skills.start.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return taughtSkills.start(context.actor, input.botId, input.goal);
      }),
      appendEvent: authed.skills.appendEvent.handler(async ({ context, input }) =>
        taughtSkills.appendEvent(context.actor, input.skillId, input.event),
      ),
      snapshot: authed.skills.snapshot.handler(async ({ context, input }) =>
        taughtSkills.snapshot(context.actor, input.skillId),
      ),
      stop: authed.skills.stop.handler(async ({ context, input }) =>
        taughtSkills.stop(context.actor, input.skillId),
      ),
      updateDraft: authed.skills.updateDraft.handler(async ({ context, input }) =>
        taughtSkills.updateDraft(context.actor, input.skillId, {
          name: input.name,
          playbook: input.playbook,
        }),
      ),
      save: authed.skills.save.handler(async ({ context, input }) =>
        taughtSkills.save(context.actor, input.skillId, input.name),
      ),
      testRun: authed.skills.testRun.handler(async ({ context, input }) =>
        taughtSkills.testRun(context.actor, input.skillId, input.prompt),
      ),
      remove: authed.skills.remove.handler(async ({ context, input }) =>
        taughtSkills.remove(context.actor, input.skillId),
      ),
    },
    agentSkills: {
      list: authed.agentSkills.list.handler(async ({ context }) => agentSkills.list(context.actor)),
      get: authed.agentSkills.get.handler(async ({ context, input }) =>
        agentSkills.get(context.actor, input),
      ),
      create: authed.agentSkills.create.handler(async ({ context, input }) =>
        agentSkills.create(context.actor, input),
      ),
      update: authed.agentSkills.update.handler(async ({ context, input }) =>
        agentSkills.update(context.actor, input),
      ),
      remove: authed.agentSkills.remove.handler(async ({ context, input }) =>
        agentSkills.remove(context.actor, input.skillId),
      ),
    },
    capabilities: {
      list: authed.capabilities.list.handler(async ({ context }) => {
        const rows = await deps.prisma.capabilityInstall.findMany({
          where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
        });
        return rows.map((row) => ({
          id: row.id,
          kind: row.kind as "skill" | "plugin" | "mcp" | "api" | "connection",
          name: row.name,
          source: row.source,
          version: row.version,
          digest: row.digest,
          secretConfigured: Boolean(row.secretId),
          config: row.config as Record<string, unknown>,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      install: authed.capabilities.install.handler(async ({ context, input }) => {
        let source = input.source.trim();
        let config = input.config;
        const credential = input.credential?.trim() || undefined;
        if (
          credential &&
          credential.length >= 8 &&
          (source.includes(credential) || containsSecret(config, [credential]))
        ) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Put credentials only in the encrypted credential field",
          });
        }
        if (JSON.stringify(config).length > 2_000_000) {
          throw new ORPCError("BAD_REQUEST", { message: "Capability configuration is too large" });
        }
        if (credential && input.kind !== "mcp" && input.kind !== "api") {
          throw new ORPCError("BAD_REQUEST", {
            message: "Credentials are only accepted for MCP and API tool sources",
          });
        }
        try {
          if (input.kind === "mcp") {
            if (config.preset === "treg") {
              source = "https://treg.to/mcp/";
              config = { ...config, preset: "treg", auth: { type: "bearer" } };
            }
            const verified = await verifyMcpInstall({
              source,
              config,
              credential,
              signal: context.signal,
              remote: deps.remoteConnectors,
            });
            config = verified.config;
          }
          if (input.kind === "api") {
            const prepared = await prepareApiInstall({
              source,
              config,
              credential,
              signal: context.signal,
              remote: deps.remoteConnectors,
            });
            source = prepared.source;
            config = prepared.config;
          }
        } catch (error) {
          const message = sanitizeComposioError(error);
          throw new ORPCError("BAD_REQUEST", {
            message: credential ? message.split(credential).join("[redacted]") : message,
          });
        }
        const stored = credential
          ? await deps.secrets.put(credential, {
              operationId: "capabilities.install",
              traceId: "capabilities.install",
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              signal: context.signal ?? new AbortController().signal,
            })
          : undefined;
        const digest = `sha256:${createHash("sha256")
          .update(JSON.stringify({ kind: input.kind, source, config }))
          .digest("hex")}`;
        const row = await deps.prisma.$transaction(async (tx) => {
          if (stored) {
            await tx.secret.create({
              data: {
                id: stored.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                kind: "connector",
                ciphertext: stored.ciphertext,
              },
            });
          }
          return tx.capabilityInstall.create({
            data: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              kind: input.kind,
              name: input.name.trim(),
              source,
              secretId: stored?.id,
              config: config as Prisma.InputJsonValue,
              digest,
              version: "1.0.0",
            },
          });
        });
        return {
          id: row.id,
          kind: row.kind as "skill" | "plugin" | "mcp" | "api" | "connection",
          name: row.name,
          source: row.source,
          version: row.version,
          digest: row.digest,
          secretConfigured: Boolean(row.secretId),
          config: row.config as Record<string, unknown>,
          createdAt: row.createdAt.toISOString(),
        };
      }),
      remove: authed.capabilities.remove.handler(async ({ context, input }) => {
        await deps.prisma.$transaction(async (tx) => {
          const existing = await tx.capabilityInstall.findFirst({
            where: {
              id: input.id,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
          });
          if (!existing) return;
          await tx.capabilityInstall.delete({ where: { id: existing.id } });
          if (existing.secretId) {
            const shared = await tx.capabilityInstall.count({
              where: { secretId: existing.secretId },
            });
            if (shared === 0) {
              await tx.secret.deleteMany({
                where: {
                  id: existing.secretId,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
              });
            }
          }
        });
        return { ok: true as const };
      }),
    },
    mcp: {
      servers: {
        list: authed.mcp.servers.list.handler(async ({ context }) => {
          const rows = await deps.prisma.mcpServer.findMany({
            where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
            orderBy: [{ name: "asc" }, { createdAt: "asc" }],
          });
          const secretIds = rows.flatMap((row) => (row.secretId ? [row.secretId] : []));
          const secrets = secretIds.length
            ? await deps.prisma.secret.findMany({
                where: {
                  id: { in: secretIds },
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
                select: { id: true, ciphertext: true },
              })
            : [];
          const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
          return rows.map((row) =>
            mcpServerDto(
              row,
              mcpOAuth.statusForCiphertext(
                row.secretId ? ciphertextById.get(row.secretId) : undefined,
                row.secretId ?? undefined,
              ),
            ),
          );
        }),
        create: authed.mcp.servers.create.handler(async ({ context, input }) => {
          const secretPayload = buildMcpCredentialBlob(input);
          const stored = secretPayload
            ? await deps.secrets.put(
                secretPayload,
                computerContext(context.actor, "mcp", "mcp.create"),
              )
            : null;
          const row = await deps.prisma.$transaction(async (tx) => {
            if (stored) {
              await tx.secret.create({
                data: {
                  id: stored.id,
                  userId: context.actor.userId,
                  spaceId: context.actor.spaceId,
                  kind: "mcp",
                  ciphertext: stored.ciphertext,
                },
              });
            }
            return tx.mcpServer.create({
              data: {
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                slug: input.slug,
                name: input.name,
                description: input.description,
                transport: input.transport,
                endpoint: "endpoint" in input ? input.endpoint : null,
                command: "command" in input ? input.command : null,
                args: ("args" in input ? input.args : []) as Prisma.InputJsonValue,
                env: ("env" in input
                  ? Object.fromEntries(Object.keys(input.env).map((key) => [key, true]))
                  : {}) as Prisma.InputJsonValue,
                headers: ("headers" in input
                  ? Object.fromEntries(Object.keys(input.headers).map((key) => [key, true]))
                  : {}) as Prisma.InputJsonValue,
                secretId: stored?.id,
                enabled: input.enabled,
              },
            });
          });
          return mcpServerDto(row, await mcpOAuth.statusFor(row, context.actor));
        }),
        update: authed.mcp.servers.update.handler(async ({ context, input }) => {
          const config = input.config;
          const row = await deps.prisma.$transaction(async (tx) => {
            // Share the OAuth broker's per-server lock so a stale authorization
            // snapshot cannot overwrite a simultaneous credential edit.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${input.id}))`;
            const existing = await tx.mcpServer.findFirst({
              where: {
                id: input.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
            });
            if (!existing) throw new IsolationError();
            const existingSecret = existing.secretId
              ? await tx.secret.findFirst({
                  where: {
                    id: existing.secretId,
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                  },
                })
              : null;
            let existingMaterial: Record<string, unknown> = {};
            if (existingSecret) {
              try {
                const value = JSON.parse(
                  deps.secrets.load(existingSecret.ciphertext, existingSecret.id),
                );
                if (value && typeof value === "object" && !Array.isArray(value))
                  existingMaterial = value as Record<string, unknown>;
              } catch {
                /* Existing malformed secrets are replaced only when new credentials are supplied. */
              }
            }
            const nextEndpoint = "endpoint" in config ? config.endpoint : null;
            const update = buildMcpUpdateMaterial(existingMaterial, config, {
              clearOAuth: existing.endpoint !== nextEndpoint,
            });
            const stored =
              update.action === "store" && Object.keys(update.material).length > 0
                ? await deps.secrets.put(
                    JSON.stringify(update.material),
                    computerContext(context.actor, "mcp", "mcp.update"),
                  )
                : null;
            const clearing = update.action === "store" && Object.keys(update.material).length === 0;
            const updated = await tx.mcpServer.update({
              where: { id: existing.id },
              data: {
                slug: config.slug,
                name: config.name,
                description: config.description,
                transport: config.transport,
                endpoint: nextEndpoint,
                command: "command" in config ? config.command : null,
                args: ("args" in config ? config.args : []) as Prisma.InputJsonValue,
                env: ("env" in config
                  ? Object.fromEntries(Object.keys(config.env).map((key) => [key, true]))
                  : {}) as Prisma.InputJsonValue,
                headers: ("headers" in config
                  ? Object.fromEntries(Object.keys(config.headers).map((key) => [key, true]))
                  : {}) as Prisma.InputJsonValue,
                enabled: config.enabled,
                revision: { increment: 1 },
                ...(stored ? { secretId: stored.id } : clearing ? { secretId: null } : {}),
              },
            });
            if (stored) {
              await tx.secret.create({
                data: {
                  id: stored.id,
                  userId: context.actor.userId,
                  spaceId: context.actor.spaceId,
                  kind: "mcp",
                  ciphertext: stored.ciphertext,
                },
              });
              if (existing.secretId)
                await tx.secret.deleteMany({
                  where: {
                    id: existing.secretId,
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                  },
                });
            } else if (clearing && existing.secretId) {
              await tx.secret.deleteMany({
                where: {
                  id: existing.secretId,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
              });
            }
            return updated;
          });
          return mcpServerDto(row, await mcpOAuth.statusFor(row, context.actor));
        }),
        remove: authed.mcp.servers.remove.handler(async ({ context, input }) => {
          const server = await deps.prisma.mcpServer.findFirst({
            where: {
              id: input.id,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            select: { id: true, secretId: true },
          });
          if (!server) throw new IsolationError();
          // Assignments cascade; the encrypted credential must go with the server.
          await deps.prisma.$transaction([
            deps.prisma.mcpServer.delete({ where: { id: server.id } }),
            ...(server.secretId
              ? [
                  deps.prisma.secret.deleteMany({
                    where: {
                      id: server.secretId,
                      spaceId: context.actor.spaceId,
                      userId: context.actor.userId,
                    },
                  }),
                ]
              : []),
          ]);
          return { ok: true as const };
        }),
      },
      assignments: {
        all: authed.mcp.assignments.all.handler(async ({ context }) => {
          const rows = await deps.prisma.botMcpServer.findMany({
            where: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              bot: { archivedAt: null },
            },
            orderBy: { createdAt: "asc" },
          });
          return rows.map(mcpAssignmentDto);
        }),
        list: authed.mcp.assignments.list.handler(async ({ context, input }) => {
          const bot = await deps.prisma.bot.findFirst({
            where: {
              id: input.botId,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            select: { id: true },
          });
          if (!bot) throw new IsolationError();
          const rows = await deps.prisma.botMcpServer.findMany({
            where: {
              botId: bot.id,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            orderBy: { createdAt: "asc" },
          });
          return rows.map(mcpAssignmentDto);
        }),
        approve: authed.mcp.assignments.approve.handler(async ({ context, input }) => {
          const row = await deps.prisma.$transaction(async (tx) => {
            const [bot, server] = await Promise.all([
              tx.bot.findFirst({
                where: {
                  id: input.botId,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
                select: { id: true },
              }),
              tx.mcpServer.findFirst({
                where: {
                  id: input.serverId,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                  enabled: true,
                },
                select: { id: true },
              }),
            ]);
            if (!bot || !server) throw new IsolationError();
            return tx.botMcpServer.upsert({
              where: { botId_serverId: { botId: bot.id, serverId: server.id } },
              create: {
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                botId: bot.id,
                serverId: server.id,
                allowAllTools: true,
                allowedTools: [],
              },
              update: {},
            });
          });
          return mcpAssignmentDto(row);
        }),
        replace: authed.mcp.assignments.replace.handler(async ({ context, input }) => {
          const result = await deps.prisma.$transaction(async (tx) => {
            const bot = await tx.bot.findFirst({
              where: {
                id: input.botId,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
              select: { id: true },
            });
            if (!bot) throw new IsolationError();
            const servers = await tx.mcpServer.findMany({
              where: {
                id: { in: input.assignments.map((assignment) => assignment.serverId) },
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
              select: { id: true },
            });
            if (servers.length !== input.assignments.length) throw new IsolationError();
            await tx.botMcpServer.deleteMany({
              where: {
                botId: bot.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
            });
            if (input.assignments.length)
              await tx.botMcpServer.createMany({
                data: input.assignments.map((assignment) => ({
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                  botId: bot.id,
                  serverId: assignment.serverId,
                  allowAllTools: assignment.allowAllTools,
                  allowedTools: assignment.allowedTools as Prisma.InputJsonValue,
                })),
              });
            return tx.botMcpServer.findMany({
              where: {
                botId: bot.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
              orderBy: { createdAt: "asc" },
            });
          });
          return result.map(mcpAssignmentDto);
        }),
      },
      oauth: {
        begin: authed.mcp.oauth.begin.handler(async ({ context, input }) => {
          try {
            const expectedRedirect = new URL("/mcp/oauth/callback", deps.env.webOrigin).toString();
            if (new URL(input.redirectUri).toString() !== expectedRedirect) {
              throw new Error("MCP OAuth redirect URI is not allowed");
            }
            return await mcpOAuth.begin({
              ...input,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            });
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not start MCP OAuth",
            });
          }
        }),
        complete: authed.mcp.oauth.complete.handler(async ({ context, input }) => {
          try {
            await mcpOAuth.complete({
              ...input,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            });
            return { ok: true as const };
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not complete MCP OAuth",
            });
          }
        }),
        disconnect: authed.mcp.oauth.disconnect.handler(async ({ context, input }) => {
          await mcpOAuth.disconnect({
            ...input,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          });
          return { ok: true as const };
        }),
      },
    },
    onboarding: {
      start: authed.onboarding.start.handler(async ({ context, input }) => {
        await startOnboarding(
          { prisma: deps.prisma, events: deps.events, composio: deps.composio },
          context.actor,
          input.botId,
        );
        return { ok: true as const };
      }),
      choose: authed.onboarding.choose.handler(async ({ context, input }) => {
        await chooseFocus(
          { prisma: deps.prisma, events: deps.events, composio: deps.composio },
          context.actor,
          input.botId,
          input.optionId,
        );
        return { ok: true as const };
      }),
      appConnected: authed.onboarding.appConnected.handler(async ({ context, input }) => {
        await markAppConnected(
          { prisma: deps.prisma, events: deps.events, composio: deps.composio },
          context.actor,
          input.botId,
          input.provider,
        );
        return { ok: true as const };
      }),
    },
    connections: {
      catalog: authed.connections.catalog.handler(async ({ context, input }) => {
        const adapterContext = connectionContext(
          context.actor,
          "connections.catalog",
          context.signal,
        );
        const providers = input.connectorId
          ? [deps.connectors.managed(input.connectorId)].filter(
              (provider): provider is NonNullable<typeof provider> => Boolean(provider),
            )
          : deps.connectors.managedProviders();
        const catalogs = await Promise.all(
          providers.map(async (provider): Promise<ConnectorCatalogItem[]> => {
            try {
              const items = await provider.catalog(adapterContext, input.query);
              const nowConnected = items.filter((item) => item.connected).map((item) => item.slug);
              if (nowConnected.length > 0) {
                await reconcilePendingConnections(
                  deps.prisma,
                  context.actor,
                  provider.describe().id,
                  nowConnected,
                ).catch((error) => {
                  console.error(
                    `${provider.describe().id} pending-connection reconciliation failed`,
                    error,
                  );
                });
              }
              return items;
            } catch {
              return [];
            }
          }),
        );
        return catalogs.flat();
      }),
      list: authed.connections.list.handler(async ({ context }) => {
        const rows = await deps.prisma.connection.findMany({
          where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
        });
        return rows.map((row) => ({
          id: row.id,
          connectorId: row.connectorId,
          provider: row.provider,
          displayName: row.displayName,
          status: row.status as "pending" | "connected" | "revoked" | "error",
          capabilities: [],
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      begin: authed.connections.begin.handler(async ({ context, input }) => {
        const connector = deps.connectors.managed(input.connectorId);
        if (!connector) {
          throw new ORPCError("BAD_REQUEST", {
            message: `Connector ${input.connectorId} is not configured`,
          });
        }
        const row = await deps.prisma.connection.create({
          data: {
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            connectorId: input.connectorId,
            provider: input.provider,
            displayName: input.displayName,
            status: "pending",
          },
        });
        try {
          const auth = await connector.begin(
            { provider: input.provider, redirectUrl: `${deps.env.webOrigin}/app` },
            connectionContext(context.actor, "connections.begin", context.signal),
          );
          await deps.prisma.connection.update({
            where: { id: row.id },
            data: {
              status: auth.authorizationUrl ? "pending" : "connected",
              providerRef: auth.state || null,
              metadata: { state: auth.state },
            },
          });
          return { connectionId: row.id, authorizationUrl: auth.authorizationUrl };
        } catch (error) {
          await deps.prisma.connection.update({
            where: { id: row.id },
            data: { status: "error" },
          });
          throw new ORPCError("BAD_REQUEST", { message: sanitizeComposioError(error) });
        }
      }),
      complete: authed.connections.complete.handler(async ({ context, input }) => {
        const existing = await deps.prisma.connection.findFirst({
          where: {
            id: input.connectionId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!existing) throw new IsolationError();
        const connector = deps.connectors.managed(existing.connectorId);
        if (!connector) {
          throw new ORPCError("BAD_REQUEST", {
            message: `Connector ${existing.connectorId} is not configured`,
          });
        }
        let row = existing;
        if (existing.status !== "connected") {
          if (input.code) {
            const state = existing.providerRef ?? existing.provider;
            try {
              await connector.complete(
                { state, code: input.code },
                connectionContext(context.actor, "connections.complete", context.signal),
              );
            } catch (error) {
              throw new ORPCError("BAD_REQUEST", { message: sanitizeComposioError(error) });
            }
          }
          const ready = await connector.connectionReady(
            connectionContext(context.actor, "connections.complete", context.signal),
            existing.provider,
          );
          if (ready) {
            row = await deps.prisma.connection.update({
              where: { id: existing.id },
              data: { status: "connected" },
            });
          }
        }
        return {
          id: row.id,
          connectorId: row.connectorId,
          provider: row.provider,
          displayName: row.displayName,
          status: row.status as "pending" | "connected" | "revoked" | "error",
          capabilities: [],
          createdAt: row.createdAt.toISOString(),
        };
      }),
      revoke: authed.connections.revoke.handler(async ({ context, input }) => {
        const row = await deps.prisma.connection.findFirst({
          where: {
            id: input.connectionId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (row) {
          const connector = deps.connectors.managed(row.connectorId);
          if (!connector) {
            throw new ORPCError("BAD_REQUEST", {
              message: `Connector ${row.connectorId} is not configured`,
            });
          }
          try {
            await connector.revoke(
              row.provider,
              connectionContext(context.actor, "connections.revoke", context.signal),
            );
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", { message: sanitizeComposioError(error) });
          }
        }
        await deps.prisma.connection.updateMany({
          where: {
            id: input.connectionId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
          data: { status: "revoked" },
        });
        return { ok: true as const };
      }),
    },
    messaging: {
      status: authed.messaging.status.handler(async ({ context }) => {
        const identities = await deps.prisma.messagingIdentity.findMany({
          where: { userId: context.actor.userId },
          orderBy: { createdAt: "asc" },
        });
        return {
          enabled: deps.messaging?.enabled ?? false,
          providers: deps.messaging?.providers ?? [],
          openSignup: deps.messaging?.openSignup ?? false,
          identities: await Promise.all(
            identities.map((identity) => messagingIdentityDto(deps.prisma, identity)),
          ),
        };
      }),
      link: {
        start: authed.messaging.link.start.handler(async ({ context, input }) => {
          const bot = await deps.prisma.bot.findFirst({
            where: {
              id: input.botId,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              archivedAt: null,
            },
            select: { id: true },
          });
          if (!bot) throw new ORPCError("NOT_FOUND");
          // One chat identity per bot: delivery mirrors a bot's replies to
          // exactly one conversation.
          const linked = await deps.prisma.messagingIdentity.findUnique({
            where: { botId: bot.id },
            select: { id: true },
          });
          if (linked) {
            throw new ORPCError("BAD_REQUEST", {
              message: "That bot is already linked to a chat app; unlink it first.",
            });
          }
          const issued = await issueMessagingLinkCode(deps.prisma, {
            userId: context.actor.userId,
            spaceId: context.actor.spaceId,
            botId: bot.id,
          });
          return {
            code: formatMessagingLinkCode(issued.code),
            expiresAt: issued.expiresAt.toISOString(),
          };
        }),
      },
      identities: {
        setBot: authed.messaging.identities.setBot.handler(async ({ context, input }) => {
          const identity = await deps.prisma.messagingIdentity.findFirst({
            where: { id: input.identityId, userId: context.actor.userId },
          });
          if (!identity) throw new ORPCError("NOT_FOUND");
          const bot = await deps.prisma.bot.findFirst({
            where: {
              id: input.botId,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              archivedAt: null,
            },
            select: { id: true },
          });
          if (!bot) throw new ORPCError("NOT_FOUND");
          try {
            const updated = await deps.prisma.messagingIdentity.update({
              where: { id: identity.id },
              // The identity must live in the bot's space: runs resolve
              // credentials, memory, and approval rules from run.spaceId.
              data: { botId: bot.id, spaceId: context.actor.spaceId },
            });
            return messagingIdentityDto(deps.prisma, updated);
          } catch (error) {
            // botId is unique: the target bot is already linked elsewhere.
            if (isUniqueViolation(error)) {
              throw new ORPCError("BAD_REQUEST", {
                message: "That bot is already linked to a chat app.",
              });
            }
            throw error;
          }
        }),
        unlink: authed.messaging.identities.unlink.handler(async ({ context, input }) => {
          const { count } = await deps.prisma.messagingIdentity.deleteMany({
            where: { id: input.identityId, userId: context.actor.userId },
          });
          if (count === 0) throw new ORPCError("NOT_FOUND");
          return { ok: true as const };
        }),
      },
      channels: {
        list: authed.messaging.channels.list.handler(async ({ context }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          if (identities.length === 0) return [];
          const memberships = await deps.prisma.messagingChannelMember.findMany({
            where: { identityId: { in: identities.map((identity) => identity.id) } },
            include: { channel: { include: { members: ACTIVE_CHANNEL_MEMBERS } } },
            orderBy: { updatedAt: "desc" },
          });
          return memberships.map((membership) => messagingChannelDto(membership));
        }),
        respond: authed.messaging.channels.respond.handler(async ({ context, input }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          const membership = identities.length
            ? await deps.prisma.messagingChannelMember.findFirst({
                where: {
                  id: input.membershipId,
                  identityId: { in: identities.map((identity) => identity.id) },
                },
                include: { channel: { include: { members: ACTIVE_CHANNEL_MEMBERS } } },
              })
            : null;
          if (membership?.status !== "invited") {
            throw new ORPCError("NOT_FOUND");
          }
          const { count } = await deps.prisma.messagingChannelMember.updateMany({
            where: { id: membership.id, status: "invited" },
            data: { status: input.accept ? "approved" : "declined" },
          });
          if (count === 0) {
            // Lost a race with leave/sweep: approval must not resurrect a
            // departed member.
            throw new ORPCError("NOT_FOUND");
          }
          const updated = await deps.prisma.messagingChannelMember.findUniqueOrThrow({
            where: { id: membership.id },
            include: { channel: { include: { members: ACTIVE_CHANNEL_MEMBERS } } },
          });
          return messagingChannelDto(updated);
        }),
        leave: authed.messaging.channels.leave.handler(async ({ context, input }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          const membership = identities.length
            ? await deps.prisma.messagingChannelMember.findFirst({
                where: {
                  id: input.membershipId,
                  identityId: { in: identities.map((identity) => identity.id) },
                },
              })
            : null;
          if (!membership) throw new ORPCError("NOT_FOUND");
          await deps.prisma.messagingChannelMember.update({
            where: { id: membership.id },
            data: { status: "left" },
          });
          return { ok: true as const };
        }),
      },
      connections: {
        list: authed.messaging.connections.list.handler(async ({ context }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          if (identities.length === 0) return [];
          const botIds = identities.map((identity) => identity.botId);
          const connections = await deps.prisma.agentConnection.findMany({
            where: {
              OR: [{ requesterBotId: { in: botIds } }, { targetBotId: { in: botIds } }],
            },
            orderBy: { updatedAt: "desc" },
          });
          const myBotIds = new Set(botIds);
          return Promise.all(
            connections.map((connection) =>
              messagingConnectionDto(deps.prisma, myBotIds, connection),
            ),
          );
        }),
        respond: authed.messaging.connections.respond.handler(async ({ context, input }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          const myBotIds = new Set(identities.map((identity) => identity.botId));
          const connection = identities.length
            ? await deps.prisma.agentConnection.findFirst({
                where: {
                  id: input.connectionId,
                  targetBotId: { in: [...myBotIds] },
                  status: "pending",
                },
              })
            : null;
          if (!connection) throw new ORPCError("NOT_FOUND");
          const { updated, notifyRequester } = await deps.prisma.$transaction(async (tx) => {
            // The claim holds the connection row lock through commit, so a
            // revoke either beats it or waits — it can never interleave with
            // the confirmation write below.
            const { count } = await tx.agentConnection.updateMany({
              where: { id: connection.id, status: "pending" },
              data: { status: input.accept ? "approved" : "declined" },
            });
            if (count === 0) {
              // Lost a race with revoke: approval must never overwrite it.
              throw new ORPCError("NOT_FOUND");
            }
            const row = await tx.agentConnection.findUniqueOrThrow({
              where: { id: connection.id },
            });
            if (!input.accept) return { updated: row, notifyRequester: false };
            // Parity with the text-command path: the requester hears about it.
            const requesterIdentity = await tx.messagingIdentity.findUnique({
              where: { botId: connection.requesterBotId },
            });
            if (!requesterIdentity) return { updated: row, notifyRequester: false };
            const key = `command:connected:${connection.id}`;
            // A re-approved pair starts a fresh cycle; clear the stale row or
            // skipDuplicates would swallow the new confirmation.
            await tx.messagingOutbound.deleteMany({ where: { idempotencyKey: key } });
            await tx.messagingOutbound.createMany({
              data: [
                {
                  idempotencyKey: key,
                  kind: "dm",
                  identityId: requesterIdentity.id,
                  body: "Your connection request was accepted. Your agents can now message each other.",
                },
              ],
              skipDuplicates: true,
            });
            return { updated: row, notifyRequester: true };
          });
          if (notifyRequester) {
            await deps.jobs.enqueue(messagingDeliverJob()).catch((error) => {
              console.error("messaging connection confirmation enqueue error", error);
            });
          }
          return messagingConnectionDto(deps.prisma, myBotIds, updated);
        }),
        revoke: authed.messaging.connections.revoke.handler(async ({ context, input }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          const botIds = identities.map((identity) => identity.botId);
          const connection = identities.length
            ? await deps.prisma.agentConnection.findFirst({
                where: {
                  id: input.connectionId,
                  OR: [{ requesterBotId: { in: botIds } }, { targetBotId: { in: botIds } }],
                },
              })
            : null;
          if (!connection) throw new ORPCError("NOT_FOUND");
          // Claim + invite cancel in one transaction. The status update holds
          // the connection row lock through commit, so a concurrent reconnect
          // (FOR UPDATE) waits until both the revoke and the invite delete
          // finish — otherwise it could reopen and create a fresh invite that
          // a post-commit deleteMany would then wipe while leaving the row
          // pending with no approval prompt.
          await deps.prisma.$transaction(async (tx) => {
            const { count } = await tx.agentConnection.updateMany({
              where: { id: connection.id, status: connection.status },
              data: { status: "revoked" },
            });
            if (count === 0) throw new ORPCError("NOT_FOUND");
            // Cancel undelivered invites, including rows the drain already
            // claimed (status sent, no providerHandle yet). Connect-invite
            // delivery holds this connection row FOR UPDATE through
            // sendDirect, so revoke either waits until the DM is sent or
            // deletes the claim before send starts.
            await tx.messagingOutbound.deleteMany({
              where: {
                idempotencyKey: `connect:${connection.requesterBotId}:${connection.targetBotId}`,
                OR: [{ status: "pending" }, { status: "sent", providerHandle: null }],
              },
            });
          });
          return { ok: true as const };
        }),
      },
    },
    approvalRules: {
      list: authed.approvalRules.list.handler(async ({ context }) => {
        const rows = await deps.prisma.actionApprovalRule.findMany({
          where: {
            spaceId: context.actor.spaceId,
            createdByUserId: context.actor.userId,
          },
          orderBy: { createdAt: "asc" },
        });
        return rows.map((row) => ({
          id: row.id,
          effect: row.effect as "always_allow" | "require_approval",
          matchKind: row.matchKind as "tool" | "connector" | "category",
          matchValue: row.matchValue,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      set: authed.approvalRules.set.handler(async ({ context, input }) => {
        const row = await deps.prisma.actionApprovalRule.upsert({
          where: {
            spaceId_createdByUserId_effect_matchKind_matchValue: {
              spaceId: context.actor.spaceId,
              createdByUserId: context.actor.userId,
              effect: input.effect,
              matchKind: input.matchKind,
              matchValue: input.matchValue,
            },
          },
          create: {
            spaceId: context.actor.spaceId,
            createdByUserId: context.actor.userId,
            effect: input.effect,
            matchKind: input.matchKind,
            matchValue: input.matchValue,
          },
          update: {},
        });
        return {
          id: row.id,
          effect: row.effect as "always_allow" | "require_approval",
          matchKind: row.matchKind as "tool" | "connector" | "category",
          matchValue: row.matchValue,
          createdAt: row.createdAt.toISOString(),
        };
      }),
      remove: authed.approvalRules.remove.handler(async ({ context, input }) => {
        await deps.prisma.actionApprovalRule.deleteMany({
          where: {
            id: input.id,
            spaceId: context.actor.spaceId,
            createdByUserId: context.actor.userId,
          },
        });
        return { ok: true as const };
      }),
    },
    autoReview: {
      get: authed.autoReview.get.handler(async ({ context }) => {
        return loadAutoReviewSettings(deps, context.actor);
      }),
      set: authed.autoReview.set.handler(async ({ context, input }) => {
        await deps.prisma.actionAutoReviewPreference.upsert({
          where: {
            spaceId_userId: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
          },
          create: {
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            enabled: input.enabled,
          },
          update: { enabled: input.enabled },
        });
        return loadAutoReviewSettings(deps, context.actor);
      }),
    },
    artifacts: {
      list: authed.artifacts.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        const rows = await deps.prisma.artifact.findMany({
          where: {
            botId: input.botId,
            groupId: null,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        return rows.map((row) => ({
          id: row.id,
          botId: row.botId,
          groupId: row.groupId,
          runId: row.runId,
          name: row.name,
          mimeType: row.mimeType,
          size: row.size,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      create: authed.artifacts.create.handler(async ({ context, input }) => {
        const botId = input.botId
          ? (await repos.getBot(context.actor, input.botId)).id
          : (await groupRepos.getGroupTarget(context.actor, input.groupId!)).members[0]?.bot.id;
        if (!botId) throw new IsolationError();
        try {
          return await createOwnedArtifact(deps, context.actor, { ...input, botId });
        } catch (error) {
          if (error instanceof AttachmentValidationError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
      }),
      get: authed.artifacts.get.handler(async ({ context, input }) => {
        if (input.groupId) {
          const group = await groupRepos.getGroupTarget(context.actor, input.groupId);
          const contextBotId = group.members[0]?.bot.id;
          if (!contextBotId) throw new IsolationError();
          return getSpaceArtifact(deps, context.actor, {
            artifactId: input.artifactId,
            groupId: input.groupId,
            contextBotId,
          });
        }
        await repos.getBot(context.actor, input.botId!);
        try {
          return await getOwnedArtifact(deps, context.actor, {
            botId: input.botId!,
            artifactId: input.artifactId,
          });
        } catch (error) {
          if (error instanceof IsolationError) throw error;
          throw error;
        }
      }),
    },
    usage: {
      list: authed.usage.list.handler(async ({ context }) => {
        const rows = await deps.prisma.usageRecord.findMany({
          where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
          orderBy: { createdAt: "desc" },
          take: 100,
        });
        return rows.map((row) => ({
          id: row.id,
          botId: row.botId,
          runId: row.runId,
          provider: row.provider,
          model: row.model,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      summary: authed.usage.summary.handler(async ({ context }) => {
        const result = await deps.prisma.usageRecord.aggregate({
          where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
          _sum: { inputTokens: true, outputTokens: true },
          _count: { _all: true },
        });
        return {
          inputTokens: result._sum.inputTokens ?? 0,
          outputTokens: result._sum.outputTokens ?? 0,
          runs: result._count._all,
        };
      }),
    },
    export: {
      bot: authed.export.bot.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.thread || !bot.computer) throw new IsolationError();
        const homeKey = bot.computer.homeKey;
        const exportContext = {
          operationId: "export",
          traceId: "export",
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          signal: new AbortController().signal,
        };
        const [memory, routines, files, history] = await Promise.all([
          deps.prisma.memoryDocument.findMany({
            where: { botId: input.botId, spaceId: context.actor.spaceId },
          }),
          deps.prisma.routine.findMany({
            where: { botId: input.botId, spaceId: context.actor.spaceId },
          }),
          (async () => {
            const exported: Array<{ path: string; content: string }> = [];
            for await (const file of deps.home.exportHome(homeKey, exportContext)) {
              exported.push({
                path: file.path,
                content: new TextDecoder().decode(file.content),
              });
            }
            return exported;
          })(),
          loadAllMessages(deps.prisma, bot.thread.id, EXPORT_MESSAGE_PAGE_SIZE),
        ]);
        return {
          version: 1 as const,
          exportedAt: new Date().toISOString(),
          bot: {
            name: bot.name,
            title: bot.title,
            description: bot.description,
            instructions: bot.instructions,
          },
          memory: memory.map((m) => ({ path: m.path, content: m.content })),
          routines: routines.map((r) => ({
            name: r.name,
            prompt: r.prompt,
            crons: r.crons,
            timezone: r.timezone,
          })),
          files,
          history,
        };
      }),
    },
    notifications: {
      registerPush: authed.notifications.registerPush.handler(async ({ context, input }) => {
        await savePushToken(deps.dataDir, context.actor.userId, input.token);
        return { ok: true as const };
      }),
      unregisterPush: authed.notifications.unregisterPush.handler(async ({ context }) => {
        await deletePushToken(deps.dataDir, context.actor.userId);
        return { ok: true as const };
      }),
    },
    search: {
      query: authed.search.query.handler(async ({ context, input }) => ({
        hits: await querySpaceSearch(deps.prisma, context.actor, input.q),
      })),
    },
    runs: {
      list: authed.runs.list.handler(async ({ context, input }) => ({
        runs: await listSpaceRuns(deps.prisma, context.actor, input.filter),
      })),
    },
    voice: {
      catalog: authed.voice.catalog.handler(async () => listVoiceCatalog()),
      status: authed.voice.status.handler(async ({ context }) => {
        const cred = await findDefaultVoiceCredential(deps.prisma, context.actor);
        return toVoiceStatus(cred);
      }),
      credentials: authed.voice.credentials.handler(async ({ context }) => {
        const rows = await deps.prisma.userVoiceCredential.findMany({
          where: { userId: context.actor.userId },
          include: {
            preferences: {
              where: { userId: context.actor.userId, spaceId: context.actor.spaceId },
            },
          },
          orderBy: newestVoiceCredentialOrder,
        });
        return rows.map((row) => {
          const preference = row.preferences[0];
          return toVoiceCredential({
            ...row,
            isDefault: preference?.isDefault ?? false,
            voiceId: preference?.voiceId ?? "",
          });
        });
      }),
      connect: authed.voice.connect.handler(async ({ context, input }) =>
        persistVoiceCredential(deps, context.actor, {
          provider: input.provider,
          plaintext: input.apiKey,
          voiceId: input.voiceId,
          signal: context.signal,
        }),
      ),
      setVoice: authed.voice.setVoice.handler(async ({ context, input }) => {
        const cred = await withSerializableRetry(() =>
          deps.prisma.$transaction(
            async (tx) => {
              const found = input.provider
                ? await tx.userVoiceCredential.findFirst({
                    where: { userId: context.actor.userId, provider: input.provider },
                    orderBy: newestVoiceCredentialOrder,
                  })
                : (
                    await tx.spaceVoicePreference.findFirst({
                      where: {
                        userId: context.actor.userId,
                        spaceId: context.actor.spaceId,
                        isDefault: true,
                      },
                      include: { credential: true },
                      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
                    })
                  )?.credential;
              if (!found) {
                throw new ORPCError("BAD_REQUEST", { message: "Connect a voice provider first." });
              }
              // Picking a voice also makes its provider the one speak/transcribe use.
              await selectSpaceVoicePreference(tx, context.actor, found.id, input.voiceId);
              return { ...found, voiceId: input.voiceId, isDefault: true };
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        );
        return toVoiceStatus(cred);
      }),
      voices: authed.voice.voices.handler(async ({ context, input }) => {
        const loaded = await loadDefaultVoiceCredential(deps, context.actor);
        if (!loaded) return [];
        const providerId = input.provider ?? loaded.cred.provider;
        const row =
          providerId === loaded.cred.provider
            ? loaded
            : await loadVoiceCredential(deps, context.actor, providerId);
        if (!row) return [];
        return createVoiceProvider(row.cred.provider).listVoices(
          row.apiKey,
          voiceContext(context.actor, context.signal),
        );
      }),
      prepare: authed.voice.prepare.handler(async ({ context, input }) =>
        prepareVoice(deps, context.actor, input),
      ),
    },
  });
}

function updaterConfig(deps: RouterDeps): UpdaterProxyConfig {
  return {
    url: deps.env.updaterUrl ?? null,
    token: deps.env.updaterToken ?? null,
    gitSha: deps.env.gitSha,
    imageTag: deps.env.imageTag ?? null,
  };
}

function mapUpdaterError(error: unknown): never {
  if (error instanceof UpdaterProxyError) {
    if (error.status === 401 || error.status === 403) {
      throw new ORPCError("FORBIDDEN", { message: error.message });
    }
    if (error.status >= 500) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", { message: error.message });
    }
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  throw new ORPCError("INTERNAL_SERVER_ERROR", {
    message: error instanceof Error ? error.message : "Update failed.",
  });
}

async function spaceNavigationDto(
  deps: RouterDeps,
  actor: Actor,
  repos: ReturnType<typeof createRepos>,
  groupRepos: ReturnType<typeof createGroupRepos>,
): Promise<SpaceNavigation> {
  const currentSpace = await deps.prisma.space.findUnique({
    where: { id: actor.spaceId },
    select: { organizationId: true },
  });
  if (!currentSpace) throw new IsolationError();
  const memberships = await deps.prisma.spaceMember.findMany({
    where: { userId: actor.userId, organizationId: currentSpace.organizationId },
    select: {
      spaceId: true,
      space: { select: { name: true, isDefault: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const spaceIds = memberships.map((membership) => membership.spaceId);
  const inactiveSpaceIds = spaceIds.filter((spaceId) => spaceId !== actor.spaceId);
  const [currentBots, currentGroups, inactiveBots, inactiveGroups, botSections] = await Promise.all(
    [
      repos.listBots(actor),
      groupRepos.listGroups(actor),
      repos.listSpaceBotsForSpaces(actor, inactiveSpaceIds),
      groupRepos.listSpaceGroupsForSpaces(actor, inactiveSpaceIds),
      repos.listBotSectionsForSpaces(actor, spaceIds),
    ],
  );
  const currentMembership = memberships.find((membership) => membership.spaceId === actor.spaceId);
  if (!currentMembership) throw new IsolationError();
  const botsBySpace = partitionBySpace([...currentBots, ...inactiveBots]);
  const groupsBySpace = partitionBySpace([...currentGroups, ...inactiveGroups]);
  const sectionsBySpace = partitionBySpace(botSections);
  const botsFor = (spaceId: string) => botsBySpace.get(spaceId) ?? [];
  const groupsFor = (spaceId: string) => groupsBySpace.get(spaceId) ?? [];
  const sectionsFor = (spaceId: string) => sectionsBySpace.get(spaceId) ?? [];

  return {
    current: {
      id: actor.spaceId,
      name: currentMembership.space.name,
      bots: currentBots,
      groups: currentGroups,
      botSections: sectionsFor(actor.spaceId),
    },
    spaces: memberships.map((membership) => {
      const spaceBots = botsFor(membership.spaceId);
      const spaceGroups = groupsFor(membership.spaceId);
      return {
        id: membership.spaceId,
        name: membership.space.name,
        isDefault: membership.space.isDefault,
        bots: spaceBots.map((bot) => ({
          id: bot.id,
          spaceId: bot.spaceId,
          name: bot.name,
          title: bot.title,
          color: bot.color,
          notifyOnFinish: bot.notifyOnFinish,
          pinned: bot.pinned,
          sectionId: bot.sectionId,
          unread: bot.unread,
          preview: bot.preview,
          status: bot.status,
          updatedAt: bot.updatedAt,
        })),
        groups: spaceGroups.map((group) => ({
          id: group.id,
          spaceId: group.spaceId,
          name: group.name,
          pinned: group.pinned,
          sectionId: group.sectionId,
          members: group.members,
          preview: group.preview,
          unread: group.unread,
          updatedAt: group.updatedAt,
        })),
        botSections: sectionsFor(membership.spaceId),
      };
    }),
  };
}

function partitionBySpace<T extends { spaceId: string }>(rows: T[]): Map<string, T[]> {
  const partitioned = new Map<string, T[]>();
  for (const row of rows) {
    const spaceRows = partitioned.get(row.spaceId) ?? [];
    spaceRows.push(row);
    partitioned.set(row.spaceId, spaceRows);
  }
  return partitioned;
}

async function loadAutoReviewSettings(deps: RouterDeps, actor: Actor) {
  const environmentAvailable = isAutoReviewCheckerConfigured({ env: process.env });
  const checker = environmentAvailable ? null : resolveAutoReviewChecker(process.env);
  const requiredUserProvider = checker?.provider === "scripted" ? null : checker?.provider;
  const [preference, credential] = await Promise.all([
    deps.prisma.actionAutoReviewPreference.findUnique({
      where: {
        spaceId_userId: {
          spaceId: actor.spaceId,
          userId: actor.userId,
        },
      },
      select: { enabled: true },
    }),
    requiredUserProvider
      ? deps.prisma.userModelCredential.findFirst({
          where: { userId: actor.userId, provider: requiredUserProvider },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);
  const enabled = preference?.enabled ?? deploymentAutoReviewDefault(process.env);
  const checkerAvailable = environmentAvailable || Boolean(credential);
  return { enabled, checkerAvailable };
}

async function meDto(deps: RouterDeps, actor: Actor): Promise<Me> {
  const [user, setup] = await Promise.all([
    deps.prisma.user.findUniqueOrThrow({ where: { id: actor.userId } }),
    modelSetup(deps, actor),
  ]);
  return {
    userId: actor.userId,
    email: user.email,
    name: user.name,
    spaceId: actor.spaceId,
    isDeploymentOwner: actor.isDeploymentOwner,
    needsModel: setup.needsModel,
    defaultProvider:
      setup.credential?.provider ??
      setup.settings?.defaultModelProvider ??
      deps.env.defaultProvider,
    defaultModel:
      setup.credential?.defaultModel ?? setup.settings?.defaultModelId ?? deps.env.defaultModel,
    computerHost: computerHostFor(setup.settings?.computerHost, deps.env.sandboxProvider),
    canChooseHostComputer: actor.isDeploymentOwner && deps.env.sandboxProvider === "docker",
    sandboxProvider: deps.env.sandboxProvider,
    avatarStyle: user.avatarStyle === "organic" ? "organic" : "robot",
  };
}

async function modelSetup(deps: RouterDeps, actor: Actor) {
  const [credential, settings] = await Promise.all([
    findDefaultModelCredential(deps.prisma, actor),
    deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
  ]);
  const hasDeployment = Boolean(deps.env.deploymentModelKey);
  return {
    credential,
    settings,
    needsModel: deps.env.agentRuntime !== "scripted" && !credential && !hasDeployment,
  };
}

async function computerStatus(
  deps: RouterDeps,
  actor: Actor,
  botId: string,
): Promise<ComputerStatus> {
  const repos = createRepos(deps.prisma);
  let bot = await repos.getBot(actor, botId);
  if (await expireStaleComputerControl(deps, bot.computer)) {
    bot = await repos.getBot(actor, botId);
  }
  const busyBotName = await resolveBusyBotName(deps.prisma, {
    computerId: bot.computer?.id,
    botId,
    botName: bot.name,
  });
  return toComputerStatus(botId, bot.computer, busyBotName);
}

async function runComputerReplace(
  deps: RouterDeps,
  context: { actor: Actor },
  botId: string,
  mode: "recover" | "reset" | "update",
  operationId: string,
): Promise<ComputerStatus> {
  const repos = createRepos(deps.prisma);
  const bot = await repos.getBot(context.actor, botId);
  if (!bot.computer) throw new IsolationError();
  if (mode === "update" && !computerSupportsUpdate(bot.computer.kind)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Computer update is not available on this device",
    });
  }
  const manualRunId = `${mode}:${randomUUID()}`;
  let lease: ComputerExecutionLease | null;
  try {
    lease = await acquireComputerExecutionLease(deps.prisma, {
      computerId: bot.computer.id,
      runId: manualRunId,
      botId: bot.id,
    });
  } catch (error) {
    if (error instanceof ComputerBusyError) {
      throw new ORPCError("CONFLICT", { message: "Computer is busy" });
    }
    throw error;
  }
  try {
    await replaceComputer(deps, bot.computer.id, mode, {
      ...computerContext(context.actor, bot.id, operationId),
      screenLeaseId: screenLeaseIdForRun(lease, manualRunId),
    });
    scheduleComputerSleep(deps.jobs, bot.computer.id);
  } catch (error) {
    if (error instanceof ComputerBusyError) {
      throw new ORPCError("CONFLICT", { message: "Computer is busy" });
    }
    throw error;
  } finally {
    await releaseComputerExecutionLease(deps.prisma, lease);
  }
  return computerStatus(deps, context.actor, botId);
}

async function expireStaleComputerControl(
  deps: RouterDeps,
  computer:
    | (NonNullable<Parameters<typeof hasActiveComputerControl>[0]> & {
        id: string;
        controlHolder?: string;
      })
    | null
    | undefined,
): Promise<boolean> {
  if (!computer || hasActiveComputerControl(computer)) return false;
  if (computer.controlHolder !== "user") return false;
  const leaseId = computer.controlLeaseId;
  // Keep a failed revoke's lease id so reconciliation can retry provider shutdown.
  if (leaseId) {
    await expireComputerControl(deps, computer.id, leaseId).catch(() => undefined);
    return true;
  }
  return clearInactiveUserComputerControl(deps.prisma, computer.id).catch(() => false);
}

async function computerScreenContext(
  prisma: PrismaClient,
  actor: Actor,
  computerId: string,
  botId: string,
  operationId: string,
): Promise<AdapterContext> {
  const context = computerContext(actor, botId, operationId);
  const lease = await prisma.computerExecutionLease.findUnique({
    where: { computerId_botId: { computerId, botId } },
    select: { runId: true, fence: true, expiresAt: true },
  });
  if (!lease || lease.expiresAt.getTime() <= Date.now()) {
    return { ...context, screenLeaseId: screenViewerLeaseId(botId) };
  }
  return { ...context, screenLeaseId: screenLeaseIdForRun(lease, lease.runId) };
}

function screenViewerLeaseId(botId: string): string {
  return screenLeaseId(`screen-view-${botId}`, 0);
}

async function deploymentDto(prisma: PrismaClient, sandboxProvider: string) {
  const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
  return {
    ownerUserId: settings?.ownerUserId ?? null,
    signupsEnabled: settings?.signupsEnabled ?? true,
    signupAllowlist: settings?.signupAllowlist
      ? settings.signupAllowlist.split(",").filter(Boolean)
      : [],
    hasDeploymentModelCredential: Boolean(settings?.deploymentModelCredentialCipher),
    defaultProvider: settings?.defaultModelProvider ?? null,
    defaultModel: settings?.defaultModelId ?? null,
    computerHost: computerHostFor(settings?.computerHost, sandboxProvider),
    canChooseHostComputer: sandboxProvider === "docker",
    sandboxProvider,
  };
}

function computerHostFor(
  stored: string | null | undefined,
  sandboxProvider: string,
): "docker" | "this-mac" | null {
  if (sandboxProvider === "desktop") return "this-mac";
  if (sandboxProvider !== "docker") return null;
  if (stored === "this-mac" || stored === "docker") return stored;
  return null;
}

async function persistModelCredential(
  deps: RouterDeps,
  actor: Actor,
  input: {
    provider: string;
    plaintext: string;
    label?: string;
    modelId?: string;
    signal?: AbortSignal;
  },
) {
  throwIfAborted(input.signal);
  const stored = await deps.secrets.put(input.plaintext, {
    operationId: "cred",
    traceId: "cred",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: input.signal ?? new AbortController().signal,
  });
  throwIfAborted(input.signal);
  const cred = await withSerializableRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        throwIfAborted(input.signal);
        const existing = await tx.userModelCredential.findFirst({
          where: { userId: actor.userId, provider: input.provider },
          orderBy: newestModelCredentialOrder,
        });
        throwIfAborted(input.signal);
        const secret = await tx.secret.create({
          data: {
            id: stored.id,
            userId: actor.userId,
            spaceId: null,
            kind: "model",
            ciphertext: stored.ciphertext,
          },
        });
        throwIfAborted(input.signal);
        const credential = !existing
          ? await tx.userModelCredential.create({
              data: {
                userId: actor.userId,
                provider: input.provider,
                label: input.label ?? input.provider,
                secretId: secret.id,
              },
            })
          : await tx.userModelCredential.update({
              where: { id: existing.id },
              data: {
                label: input.label ?? input.provider,
                secretId: secret.id,
              },
            });
        throwIfAborted(input.signal);
        const defaultModel = input.modelId ?? deps.env.defaultModel;
        await selectSpaceModelPreference(tx, actor, credential.id, defaultModel);
        throwIfAborted(input.signal);
        if (existing) {
          await deleteUnreferencedCredentialSecret(tx, {
            credentialKind: "model",
            credentialId: existing.id,
            secretId: existing.secretId,
          });
          throwIfAborted(input.signal);
        }
        return { ...credential, isDefault: true, defaultModel };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return modelCredentialDto(cred, input.plaintext);
}

async function requireSpaceOwner(prisma: PrismaClient, actor: Actor): Promise<void> {
  const member = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    select: { role: true },
  });
  const roles = member?.role.split(",").map((role) => role.trim());
  if (!roles?.includes("owner")) throw new ORPCError("FORBIDDEN");
}

export async function persistMemoryProviderConfig(
  deps: RouterDeps,
  actor: Actor,
  input: {
    provider: string;
    settings: Record<string, string>;
    credentials: Record<string, string>;
    defaultMemoryScope: "isolated" | "shared";
  },
) {
  await requireSpaceOwner(deps.prisma, actor);
  const prepared = await prepareMemoryProviderConnection(input).catch((error: unknown) => {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Memory provider connection failed",
    });
  });
  const stored = await deps.secrets.put(JSON.stringify(prepared.credentials), {
    operationId: "memory-provider-config",
    traceId: "memory-provider-config",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: new AbortController().signal,
  });
  const config = await withSerializableRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const existing = await findSpaceMemoryConfig(tx, actor.spaceId);
        const secret = await tx.secret.create({
          data: {
            id: stored.id,
            userId: actor.userId,
            spaceId: actor.spaceId,
            kind: "memory-provider",
            ciphertext: stored.ciphertext,
          },
        });
        const updated = await tx.spaceMemoryConfig.upsert({
          where: { spaceId: actor.spaceId },
          create: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            provider: prepared.provider,
            settings: prepared.settings,
            secretId: secret.id,
            defaultMemoryScope: input.defaultMemoryScope,
          },
          update: {
            userId: actor.userId,
            provider: prepared.provider,
            settings: prepared.settings,
            secretId: secret.id,
            defaultMemoryScope: input.defaultMemoryScope,
          },
        });
        if (existing && existing.secretId !== secret.id) {
          await tx.secret.deleteMany({ where: { id: existing.secretId } });
        }
        return updated;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return serializeSpaceMemoryConfig(config);
}

export async function updateMemoryProviderDefaultScope(
  deps: RouterDeps,
  actor: Actor,
  defaultMemoryScope: "isolated" | "shared",
) {
  await requireSpaceOwner(deps.prisma, actor);
  const existing = await findSpaceMemoryConfig(deps.prisma, actor.spaceId);
  if (!existing) throw new ORPCError("NOT_FOUND");
  const updated = await deps.prisma.spaceMemoryConfig.update({
    where: { id: existing.id },
    data: { defaultMemoryScope },
  });
  return serializeSpaceMemoryConfig(updated);
}

function serializeSpaceMemoryConfig(config: {
  provider: string;
  settings: unknown;
  defaultMemoryScope: string;
  updatedAt: Date;
}) {
  return {
    provider: config.provider,
    settings: toStringRecord(config.settings),
    defaultMemoryScope: config.defaultMemoryScope as "isolated" | "shared",
    updatedAt: config.updatedAt.toISOString(),
  };
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error("Request cancelled");
}

function nextRoutineDate(crons: string[], timezone: string): Date {
  let next: Date | null;
  try {
    next = nextCronDateAcrossStrict(crons, new Date(), timezone);
  } catch {
    throw new ORPCError("BAD_REQUEST", { message: "Enter a valid cron expression." });
  }
  if (!next) throw new ORPCError("BAD_REQUEST", { message: "Enter a valid cron expression." });
  return next;
}

function mapRoutine(row: {
  id: string;
  botId: string;
  name: string;
  prompt: string;
  crons: string[];
  timezone: string;
  active: boolean;
  notify: boolean;
  webhookEnabled: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    botId: row.botId,
    name: row.name,
    prompt: row.prompt,
    crons: row.crons,
    timezone: row.timezone,
    active: row.active,
    notify: row.notify,
    webhookEnabled: row.webhookEnabled,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function listRoutinesDto(deps: RouterDeps, actor: Actor, botId: string) {
  const rows = await deps.prisma.routine.findMany({
    where: { botId, spaceId: actor.spaceId },
  });
  return rows.map(mapRoutine);
}

function withViewOnly(url: string, viewOnly: boolean) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("view_only", viewOnly ? "true" : "false");
    return parsed.toString();
  } catch {
    const join = url.includes("?") ? "&" : "?";
    return `${url}${join}view_only=${viewOnly ? "true" : "false"}`;
  }
}

function duplicateBotName(name: string) {
  return `${name.slice(0, 75)} copy`;
}

const ACTIVE_CHANNEL_MEMBERS = {
  where: { status: { in: ["invited", "approved"] } },
  select: { id: true },
};

type MessagingIdentityRecord = {
  id: string;
  botId: string;
};

/** Every linked chat app counts: channels and connections span identities. */
async function messagingIdentitiesFor(
  prisma: PrismaClient,
  userId: string,
): Promise<MessagingIdentityRecord[]> {
  return prisma.messagingIdentity.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { id: true, botId: true },
  });
}

async function messagingIdentityDto(
  prisma: PrismaClient,
  identity: { id: string; provider: string; address: string; botId: string },
) {
  const bot = await prisma.bot.findUnique({
    where: { id: identity.botId },
    select: { name: true },
  });
  return {
    id: identity.id,
    provider: identity.provider,
    address: identity.address,
    botId: identity.botId,
    botName: bot?.name ?? "Assistant",
  };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function messagingChannelDto(membership: {
  id: string;
  channelId: string;
  // Never null here: every membership reaching this DTO was matched by one of
  // the caller's identity ids.
  identityId: string | null;
  status: string;
  channel: { provider: string; name: string | null; members: Array<{ id: string }> };
}) {
  return {
    id: membership.id,
    channelId: membership.channelId,
    identityId: membership.identityId!,
    provider: membership.channel.provider,
    name: membership.channel.name,
    status: membership.status as "invited" | "approved" | "declined" | "left",
    memberCount: membership.channel.members.length,
  };
}

async function messagingConnectionDto(
  prisma: PrismaClient,
  myBotIds: ReadonlySet<string>,
  connection: {
    id: string;
    requesterBotId: string;
    targetBotId: string;
    status: string;
  },
) {
  const incoming = myBotIds.has(connection.targetBotId);
  // The target's identity stays opaque until they approve (mirrors connect_agent).
  if (!incoming && connection.status !== "approved") {
    return {
      id: connection.id,
      peerBotName: "agent",
      peerOwnerLabel: "owner",
      status: connection.status as "pending" | "approved" | "declined" | "revoked",
      incoming,
    };
  }
  const peerBotId = incoming ? connection.requesterBotId : connection.targetBotId;
  const peerBot = await prisma.bot.findUnique({
    where: { id: peerBotId },
    select: { name: true },
  });
  const peerIdentity = await prisma.messagingIdentity.findUnique({
    where: { botId: peerBotId },
    select: { userId: true },
  });
  const peerOwner = peerIdentity
    ? await prisma.user.findUnique({
        where: { id: peerIdentity.userId },
        select: { name: true },
      })
    : null;
  return {
    id: connection.id,
    peerBotName: peerBot?.name ?? "agent",
    peerOwnerLabel: peerOwner?.name.trim().split(/\s+/)[0] || "owner",
    status: connection.status as "pending" | "approved" | "declined" | "revoked",
    incoming,
  };
}
