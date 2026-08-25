import { createHash, randomUUID } from "node:crypto";
import { implement, ORPCError } from "@orpc/server";
import {
  type AdapterContext,
  type AgentHomeStore,
  type ArtifactStore,
  type ConnectorCatalogItem,
  computerControlExpireJobKey,
  type JobPublisher,
  type MemoryStore,
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
  checkpointAndRecordComputerWorkspace,
  createVoiceProvider,
  destroyBot,
  displayBotWorkspacePath,
  type EncryptedSecretStore,
  enqueueTakeoverContinuation,
  expireComputerControl,
  hasActiveComputerControl,
  listPiCatalog,
  McpOAuthBroker,
  type MemoryProviderResolver,
  modelCredentialDto,
  type PiOAuthLogins,
  planLiveConnectionSync,
  prepareApiInstall,
  prepareMemoryProviderConnection,
  probeOpenAiCompatibleModels,
  provisionComputer,
  type RemoteConnectorDependencies,
  releaseComputerExecutionLease,
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
} from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  AttachmentValidationError,
  containsSecret,
  isOneShotRoutineCron,
  nextCronDate,
} from "@rakazo/core";
import {
  appendEventInTransaction,
  createGroupRepos,
  createRepos,
  createThreadMessageInTransaction,
  findDefaultModelCredential,
  findDefaultVoiceCredential,
  findWorkspaceMemoryConfig,
  IsolationError,
  lockOwnedGroup,
  newestModelCredentialOrder,
  newestVoiceCredentialOrder,
  Prisma,
  type PrismaClient,
  parseComputerMode,
  type ThreadEvents,
  touchGroupUpdatedAt,
} from "@rakazo/db";
import { createOwnedArtifact, getOwnedArtifact, getWorkspaceArtifact } from "./artifacts.js";
import { toComputerStatus } from "./computer-status.js";
import { buildMcpUpdateMaterial } from "./mcp-material.js";
import { chooseFocus, markAppConnected, startOnboarding } from "./onboarding.js";
import { addScreenProxyCapability } from "./screen-proxy.js";
import { queryWorkspaceSearch } from "./search.js";
import { withSerializableRetry } from "./serializable-retry.js";
import { assertTeachingSendAllowed, createTaughtSkillsService } from "./taught-skills.js";
import { loadAllMessages, loadMessagePage } from "./thread-message-pages.js";
import {
  resolveThreadTarget,
  sendThreadMessage,
  setThreadUnreadState,
  stopThreadRuns,
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
  owner: Pick<Actor, "workspaceId" | "userId">,
  connectorId: string,
  connectedProviders: string[],
): Promise<void> {
  const rows = await prisma.connection.findMany({
    where: {
      workspaceId: owner.workspaceId,
      userId: owner.userId,
      connectorId,
      provider: { in: connectedProviders },
      status: { in: ["pending", "connected"] },
    },
    select: { id: true, provider: true, displayName: true, status: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const sync = planLiveConnectionSync(rows, connectedProviders);
  const updates = [
    ...(sync.connectIds.length > 0
      ? [
          prisma.connection.updateMany({
            where: {
              id: { in: sync.connectIds },
              workspaceId: owner.workspaceId,
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
              workspaceId: owner.workspaceId,
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
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    botId,
    signal: new AbortController().signal,
  };
}

function mcpServerDto(
  row: {
    id: string;
    workspaceId: string;
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
    workspaceId: row.workspaceId,
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
  actor: Pick<Actor, "workspaceId" | "userId">,
  operationId: string,
  signal?: AbortSignal,
): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    workspaceId: actor.workspaceId,
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
  env: {
    defaultProvider: string;
    defaultModel: string;
    openRouterKey?: string;
    webOrigin: string;
    screenProxySecret: string;
    sandboxProvider: string;
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

  const authed = os.use(async ({ context, next }) => {
    if (!context.actor) throw new ORPCError("UNAUTHORIZED");
    return next({ context: { ...context, actor: context.actor } });
  });

  return os.router({
    health: os.health.handler(async () => ({ ok: true as const, version: "0.1.0" })),
    me: authed.me.handler(async ({ context }): Promise<Me> => meDto(deps, context.actor)),
    bootstrap: authed.bootstrap.handler(async ({ context, input }) => {
      const actor = context.actor;
      const [me, bots, botSections, archivedBots] = await Promise.all([
        meDto(deps, actor),
        repos.listBots(actor),
        repos.listBotSections(actor),
        repos.listBots(actor, { archived: true }),
      ]);
      const active = bots.find((bot) => bot.id === input.botId) ?? bots[0];
      const [thread, routines] = active
        ? await Promise.all([
            resolveThreadTarget(deps.prisma, actor, { botId: active.id }).then((target) =>
              threadSnapshot(deps, target),
            ),
            listRoutinesDto(deps, actor, active.id),
          ])
        : [null, []];
      return { me, bots, botSections, archivedBots, thread, routines };
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
            computerHost: input.computerHost ?? undefined,
          },
          update: {
            ...(input.signupsEnabled === undefined ? {} : { signupsEnabled: input.signupsEnabled }),
            ...(input.signupAllowlist ? { signupAllowlist: input.signupAllowlist.join(",") } : {}),
            ...(input.computerHost === undefined ? {} : { computerHost: input.computerHost }),
          },
        });
        return deploymentDto(deps.prisma, deps.env.sandboxProvider);
      }),
    },
    models: {
      list: authed.models.list.handler(async () => [...listPiCatalog(), scriptedCatalogEntry]),
      credentials: authed.models.credentials.handler(async ({ context }) => {
        const rows = await deps.prisma.userModelCredential.findMany({
          where: { userId: context.actor.userId, workspaceId: context.actor.workspaceId },
          orderBy: newestModelCredentialOrder,
        });
        const compatibleRows = rows.filter((row) => row.provider === OPENAI_COMPATIBLE_PROVIDER_ID);
        const secrets = compatibleRows.length
          ? await deps.prisma.secret.findMany({
              where: {
                id: { in: compatibleRows.map((row) => row.secretId) },
                userId: context.actor.userId,
                workspaceId: context.actor.workspaceId,
              },
              select: { id: true, ciphertext: true },
            })
          : [];
        const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
        return rows.map((row) => {
          const ciphertext = ciphertextById.get(row.secretId);
          if (!ciphertext) return modelCredentialDto(row);
          try {
            return modelCredentialDto(row, deps.secrets.load(ciphertext));
          } catch {
            return modelCredentialDto(row);
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
          workspaceId: context.actor.workspaceId,
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
          workspaceId: context.actor.workspaceId,
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
                where: {
                  userId: context.actor.userId,
                  workspaceId: context.actor.workspaceId,
                  provider: input.provider,
                },
                orderBy: newestModelCredentialOrder,
              });
              if (!credential) {
                throw new ORPCError("NOT_FOUND", {
                  message: `No model credential is connected for ${input.provider} in this workspace.`,
                });
              }
              await tx.userModelCredential.updateMany({
                where: {
                  userId: context.actor.userId,
                  workspaceId: context.actor.workspaceId,
                },
                data: { isDefault: false },
              });
              await tx.userModelCredential.update({
                where: { id: credential.id },
                data: { defaultModel: input.modelId, isDefault: true },
              });
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
        });
        const assignments = await deps.prisma.botMcpServer.findMany({
          where: {
            botId: source.id,
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
          },
        });
        if (assignments.length) {
          await deps.prisma.botMcpServer.createMany({
            data: assignments.map((assignment) => ({
              workspaceId: context.actor.workspaceId,
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
      update: authed.bots.update.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        if (input.sectionId) {
          const section = await deps.prisma.botSection.findFirst({
            where: {
              id: input.sectionId,
              workspaceId: context.actor.workspaceId,
              userId: context.actor.userId,
            },
            select: { id: true },
          });
          if (!section) throw new IsolationError();
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
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
            signal: new AbortController().signal,
          },
          { deleteMemories: input.deleteMemories },
        );
        return { ok: true as const };
      }),
    },
    groups: {
      create: authed.groups.create.handler(async ({ context, input }) =>
        groupRepos.createGroup(context.actor, input),
      ),
      list: authed.groups.list.handler(async ({ context }) => groupRepos.listGroups(context.actor)),
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
      update: authed.groups.update.handler(async ({ context, input }) => {
        const updated = await groupRepos.updateGroup(context.actor, input);
        await Promise.all(
          updated.cancelledRunIds.map((runId) =>
            deps.jobs.cancel(runJobKey(runId)).catch(() => undefined),
          ),
        );
        return updated.group;
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
        );
      }),
      subscribe: authed.threads.subscribe.handler(async function* ({ context, input }) {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        for await (const event of deps.events.follow(
          target.threadId,
          input.cursor,
          context.signal,
        )) {
          yield event;
        }
      }),
      send: authed.threads.send.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        if (target.kind === "bot") {
          await assertTeachingSendAllowed(deps.prisma, context.actor.workspaceId, target.botId);
        }
        return sendThreadMessage(deps, context.actor, target, input);
      }),
      stop: authed.threads.stop.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        await stopThreadRuns(deps, context.actor, target);
        return { ok: true as const };
      }),
      clear: authed.threads.clear.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.thread) throw new IsolationError();
        const { cancelledRunIds, historyCompactionGeneration } = await deps.events.clearThread({
          workspaceId: context.actor.workspaceId,
          threadId: bot.thread.id,
          botId: bot.id,
        });
        const [configuredMemory] = await Promise.all([
          deps.memoryProviders.resolve(context.actor.workspaceId).catch((error) => {
            console.error("semantic memory resolution after thread clear failed", error);
            return null;
          }),
          Promise.all(
            cancelledRunIds.map((runId) =>
              deps.jobs.cancel(runJobKey(runId)).catch(() => undefined),
            ),
          ),
        ]);
        // Durable memories remain in their workspace/private containers. Clear only removes
        // conversation-derived summaries from the previous generation; including the new
        // generation also covers a compaction job that began just after the clear committed.
        if (configuredMemory) {
          // Best effort: the conversation rows are already deleted, so failing the clear here
          // would help nothing — a failed purge only leaves stale summaries recallable.
          try {
            const purged = await configuredMemory.provider.purgeHistory(
              {
                botId: bot.id,
                generations: [
                  Math.max(0, historyCompactionGeneration - 1),
                  historyCompactionGeneration,
                ],
              },
              computerContext(context.actor, bot.id, `thread-clear:${bot.thread.id}`),
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
          await assertTeachingSendAllowed(deps.prisma, context.actor.workspaceId, target.botId);
          const sent = await deps.events.sendUserMessage({
            workspaceId: context.actor.workspaceId,
            threadId: target.threadId,
            botId: target.botId,
            userId: context.actor.userId,
            blocks: [{ kind: "text", text: input.text }],
            prompt: input.text,
            trigger: "follow_up",
            onlyIfIdle: true,
          });
          if (sent.runId) {
            await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
              console.error("follow-up enqueue", error);
            });
          }
          return { ok: true as const };
        }
        const committed = await deps.prisma.$transaction(async (tx) => {
          await lockOwnedGroup(tx, context.actor, target.groupId);
          const group = await tx.chatGroup.findFirst({
            where: { id: target.groupId, thread: { id: target.threadId } },
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
              status: { in: ["running", "queued", "leased"] },
            },
            select: { id: true },
          });
          let run: { id: string } | null = null;
          if (!active) {
            const task = await tx.task.create({
              data: {
                workspaceId: context.actor.workspaceId,
                botId,
                threadId: target.threadId,
                userId: context.actor.userId,
                prompt: input.text,
                status: "queued",
              },
            });
            run = await tx.run.create({
              data: {
                workspaceId: context.actor.workspaceId,
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
          }
          const event = await appendEventInTransaction(tx, {
            workspaceId: context.actor.workspaceId,
            threadId: target.threadId,
            botId,
            type: "thread.message.created",
            runId: run?.id,
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
          workspaceId: context.actor.workspaceId,
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
        const executionLeaseActive = Boolean(
          executionLease && executionLease.expiresAt.getTime() > Date.now(),
        );
        const executionRun = executionLease
          ? await deps.prisma.run.findUnique({
              where: { id: executionLease.runId },
              select: { botId: true, status: true },
            })
          : null;
        const executionRunActive = Boolean(
          executionRun && ACTIVE_RUN_STATUSES.some((status) => status === executionRun.status),
        );
        const waitingForTakeover =
          executionRun?.botId === bot.id && executionRun.status === "waiting_takeover";
        if (executionLease && !waitingForTakeover && (executionLeaseActive || executionRunActive)) {
          throw new ORPCError("CONFLICT", { message: "Stop the bot first" });
        }
        if (executionLease && !executionLeaseActive && !executionRunActive) {
          await deps.prisma.computerExecutionLease.deleteMany({
            where: { id: executionLease.id },
          });
        }

        const leaseId = randomUUID();
        const expiresAt = new Date(Date.now() + takeoverLeaseMs());
        const granted = await deps.prisma.computer.updateMany({
          where: {
            id: bot.computer.id,
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
            workspaceId: context.actor.workspaceId,
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
        if (
          !hasActiveComputerControl(bot.computer) ||
          bot.computer.controlHolder !== "user" ||
          !controlBotId ||
          !controlLeaseId ||
          controlBotId !== bot.id
        ) {
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
          workspaceId: context.actor.workspaceId,
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
        const session = await deps.sandbox.connectScreen(
          toComputerRef(bot.computer),
          {
            view: "stream",
            interactive:
              hasActiveComputerControl(bot.computer) && bot.computer.controlBotId === bot.id,
            controlToken:
              bot.computer.controlBotId === bot.id
                ? (bot.computer.controlLeaseId ?? undefined)
                : undefined,
          },
          await computerScreenContext(
            deps.prisma,
            context.actor,
            bot.computer.id,
            bot.id,
            "screen",
          ),
        );
        if (!session.url) return { url: null };
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
            workspaceId: context.actor.workspaceId,
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
            workspaceId: context.actor.workspaceId,
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
            workspaceId: context.actor.workspaceId,
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
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
            ...(input.botId ? { botId: input.botId } : {}),
          },
        });
        return docs.map((d) => `# ${d.path}\n\n${d.content}`).join("\n\n");
      }),
      providerConfig: authed.memory.providerConfig.handler(async ({ context }) => {
        const config = await findWorkspaceMemoryConfig(deps.prisma, context.actor.workspaceId);
        return config ? serializeWorkspaceMemoryConfig(config) : null;
      }),
      connectProvider: authed.memory.connectProvider.handler(async ({ context, input }) =>
        persistMemoryProviderConfig(deps, context.actor, input),
      ),
      setDefaultScope: authed.memory.setDefaultScope.handler(async ({ context, input }) =>
        updateMemoryProviderDefaultScope(deps, context.actor, input.defaultMemoryScope),
      ),
      disconnectProvider: authed.memory.disconnectProvider.handler(async ({ context }) => {
        await requireWorkspaceOwner(deps.prisma, context.actor);
        await withSerializableRetry(() =>
          deps.prisma.$transaction(
            async (tx) => {
              const existing = await findWorkspaceMemoryConfig(tx, context.actor.workspaceId);
              if (!existing) return;
              await tx.workspaceMemoryConfig.delete({ where: { id: existing.id } });
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
        if (input.active && isOneShotRoutineCron(input.cron)) {
          throw new ORPCError("BAD_REQUEST", {
            message: "One-shot schedules must be created from chat.",
          });
        }
        const bot = await repos.getBot(context.actor, input.botId);
        // Validate recurring cron even when inactive; @once has no next date.
        let nextRunAt: Date | null = null;
        if (!isOneShotRoutineCron(input.cron)) {
          const computedNextRunAt = nextRoutineDate(input.cron, input.timezone);
          nextRunAt = input.active ? computedNextRunAt : null;
        }
        const row = await deps.prisma.routine.create({
          data: {
            workspaceId: context.actor.workspaceId,
            botId: input.botId,
            userId: context.actor.userId,
            name: input.name,
            prompt: input.prompt,
            cron: input.cron,
            timezone: input.timezone,
            notify: input.notify,
            active: input.active,
            nextRunAt,
          },
        });
        if (bot.thread) {
          await deps.events.append({
            workspaceId: context.actor.workspaceId,
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
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
          },
        });
        if (!existing) throw new IsolationError();
        const active = input.active ?? existing.active;
        const cron = input.cron ?? existing.cron;
        const timezone = input.timezone ?? existing.timezone;
        if (active && isOneShotRoutineCron(cron)) {
          if (!isOneShotRoutineCron(existing.cron)) {
            throw new ORPCError("BAD_REQUEST", {
              message: "One-shot schedules must be created from chat.",
            });
          }
          if (!existing.nextRunAt) {
            throw new ORPCError("BAD_REQUEST", {
              message: "One-shot schedules cannot be reactivated after they fire.",
            });
          }
        }
        const scheduleChanged =
          (!existing.active && active) ||
          (input.cron !== undefined && input.cron !== existing.cron) ||
          (input.timezone !== undefined && input.timezone !== existing.timezone);
        const recalculatedNextRunAt =
          !isOneShotRoutineCron(cron) && (scheduleChanged || (active && !existing.nextRunAt))
            ? nextRoutineDate(cron, timezone)
            : null;
        const nextRunAt = !active
          ? null
          : isOneShotRoutineCron(cron)
            ? existing.nextRunAt
            : (recalculatedNextRunAt ?? existing.nextRunAt);
        const row = await deps.prisma.routine.update({
          where: { id: existing.id },
          data: {
            name: input.name,
            prompt: input.prompt,
            cron: input.cron,
            timezone: input.timezone,
            active: input.active,
            notify: input.notify,
            nextRunAt,
          },
        });
        const bot = await repos.getBot(context.actor, row.botId);
        if (bot.thread) {
          await deps.events.append({
            workspaceId: context.actor.workspaceId,
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
          where: { id: input.routineId, workspaceId: context.actor.workspaceId },
        });
        if (!existing) throw new IsolationError();
        await deps.prisma.routine.delete({ where: { id: existing.id } });
        await deps.jobs.cancel(routineJobKey(existing.id));
        return { ok: true as const };
      }),
      testRun: authed.routines.testRun.handler(async ({ context, input }) => {
        const routine = await deps.prisma.routine.findFirst({
          where: { id: input.routineId, workspaceId: context.actor.workspaceId },
        });
        if (!routine) throw new IsolationError();
        const bot = await repos.getBot(context.actor, routine.botId);
        if (!bot.thread) throw new IsolationError();
        const task = await deps.prisma.task.create({
          data: {
            workspaceId: context.actor.workspaceId,
            botId: bot.id,
            threadId: bot.thread.id,
            userId: context.actor.userId,
            prompt: routine.prompt,
            status: "queued",
          },
        });
        const run = await deps.prisma.run.create({
          data: {
            workspaceId: context.actor.workspaceId,
            botId: bot.id,
            threadId: bot.thread.id,
            taskId: task.id,
            userId: context.actor.userId,
            status: "queued",
            trigger: "routine",
          },
        });
        await deps.jobs.enqueue(runContinueJob(run.id));
        return { runId: run.id };
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
    capabilities: {
      list: authed.capabilities.list.handler(async ({ context }) => {
        const rows = await deps.prisma.capabilityInstall.findMany({
          where: { workspaceId: context.actor.workspaceId, userId: context.actor.userId },
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
              workspaceId: context.actor.workspaceId,
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
                workspaceId: context.actor.workspaceId,
                userId: context.actor.userId,
                kind: "connector",
                ciphertext: stored.ciphertext,
              },
            });
          }
          return tx.capabilityInstall.create({
            data: {
              workspaceId: context.actor.workspaceId,
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
              workspaceId: context.actor.workspaceId,
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
                  workspaceId: context.actor.workspaceId,
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
            where: { workspaceId: context.actor.workspaceId, userId: context.actor.userId },
            orderBy: [{ name: "asc" }, { createdAt: "asc" }],
          });
          const secretIds = rows.flatMap((row) => (row.secretId ? [row.secretId] : []));
          const secrets = secretIds.length
            ? await deps.prisma.secret.findMany({
                where: {
                  id: { in: secretIds },
                  workspaceId: context.actor.workspaceId,
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
                  workspaceId: context.actor.workspaceId,
                  kind: "mcp",
                  ciphertext: stored.ciphertext,
                },
              });
            }
            return tx.mcpServer.create({
              data: {
                workspaceId: context.actor.workspaceId,
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
                workspaceId: context.actor.workspaceId,
                userId: context.actor.userId,
              },
            });
            if (!existing) throw new IsolationError();
            const existingSecret = existing.secretId
              ? await tx.secret.findFirst({
                  where: {
                    id: existing.secretId,
                    workspaceId: context.actor.workspaceId,
                    userId: context.actor.userId,
                  },
                })
              : null;
            let existingMaterial: Record<string, unknown> = {};
            if (existingSecret) {
              try {
                const value = JSON.parse(deps.secrets.load(existingSecret.ciphertext));
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
                  workspaceId: context.actor.workspaceId,
                  kind: "mcp",
                  ciphertext: stored.ciphertext,
                },
              });
              if (existing.secretId)
                await tx.secret.deleteMany({
                  where: {
                    id: existing.secretId,
                    workspaceId: context.actor.workspaceId,
                    userId: context.actor.userId,
                  },
                });
            } else if (clearing && existing.secretId) {
              await tx.secret.deleteMany({
                where: {
                  id: existing.secretId,
                  workspaceId: context.actor.workspaceId,
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
              workspaceId: context.actor.workspaceId,
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
                      workspaceId: context.actor.workspaceId,
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
              workspaceId: context.actor.workspaceId,
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
              workspaceId: context.actor.workspaceId,
              userId: context.actor.userId,
            },
            select: { id: true },
          });
          if (!bot) throw new IsolationError();
          const rows = await deps.prisma.botMcpServer.findMany({
            where: {
              botId: bot.id,
              workspaceId: context.actor.workspaceId,
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
                  workspaceId: context.actor.workspaceId,
                  userId: context.actor.userId,
                },
                select: { id: true },
              }),
              tx.mcpServer.findFirst({
                where: {
                  id: input.serverId,
                  workspaceId: context.actor.workspaceId,
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
                workspaceId: context.actor.workspaceId,
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
                workspaceId: context.actor.workspaceId,
                userId: context.actor.userId,
              },
              select: { id: true },
            });
            if (!bot) throw new IsolationError();
            const servers = await tx.mcpServer.findMany({
              where: {
                id: { in: input.assignments.map((assignment) => assignment.serverId) },
                workspaceId: context.actor.workspaceId,
                userId: context.actor.userId,
              },
              select: { id: true },
            });
            if (servers.length !== input.assignments.length) throw new IsolationError();
            await tx.botMcpServer.deleteMany({
              where: {
                botId: bot.id,
                workspaceId: context.actor.workspaceId,
                userId: context.actor.userId,
              },
            });
            if (input.assignments.length)
              await tx.botMcpServer.createMany({
                data: input.assignments.map((assignment) => ({
                  workspaceId: context.actor.workspaceId,
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
                workspaceId: context.actor.workspaceId,
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
              workspaceId: context.actor.workspaceId,
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
              workspaceId: context.actor.workspaceId,
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
            workspaceId: context.actor.workspaceId,
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
          where: { workspaceId: context.actor.workspaceId, userId: context.actor.userId },
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
            workspaceId: context.actor.workspaceId,
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
            workspaceId: context.actor.workspaceId,
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
            workspaceId: context.actor.workspaceId,
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
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
          },
          data: { status: "revoked" },
        });
        return { ok: true as const };
      }),
    },
    approvalRules: {
      list: authed.approvalRules.list.handler(async ({ context }) => {
        const rows = await deps.prisma.actionApprovalRule.findMany({
          where: {
            workspaceId: context.actor.workspaceId,
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
            workspaceId_createdByUserId_effect_matchKind_matchValue: {
              workspaceId: context.actor.workspaceId,
              createdByUserId: context.actor.userId,
              effect: input.effect,
              matchKind: input.matchKind,
              matchValue: input.matchValue,
            },
          },
          create: {
            workspaceId: context.actor.workspaceId,
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
            workspaceId: context.actor.workspaceId,
            createdByUserId: context.actor.userId,
          },
        });
        return { ok: true as const };
      }),
    },
    artifacts: {
      list: authed.artifacts.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        const rows = await deps.prisma.artifact.findMany({
          where: {
            botId: input.botId,
            groupId: null,
            workspaceId: context.actor.workspaceId,
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
          return getWorkspaceArtifact(deps, context.actor, {
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
          where: { workspaceId: context.actor.workspaceId, userId: context.actor.userId },
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
          where: { workspaceId: context.actor.workspaceId, userId: context.actor.userId },
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
          workspaceId: context.actor.workspaceId,
          userId: context.actor.userId,
          signal: new AbortController().signal,
        };
        const [memory, routines, files, history] = await Promise.all([
          deps.prisma.memoryDocument.findMany({
            where: { botId: input.botId, workspaceId: context.actor.workspaceId },
          }),
          deps.prisma.routine.findMany({
            where: { botId: input.botId, workspaceId: context.actor.workspaceId },
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
            cron: r.cron,
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
    },
    search: {
      query: authed.search.query.handler(async ({ context, input }) => ({
        hits: await queryWorkspaceSearch(deps.prisma, context.actor, input.q),
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
          where: { userId: context.actor.userId, workspaceId: context.actor.workspaceId },
          orderBy: newestVoiceCredentialOrder,
        });
        return rows.map(toVoiceCredential);
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
                ? await tx.userVoiceCredential.findUnique({
                    where: {
                      userId_workspaceId_provider: {
                        userId: context.actor.userId,
                        workspaceId: context.actor.workspaceId,
                        provider: input.provider,
                      },
                    },
                  })
                : await tx.userVoiceCredential.findFirst({
                    where: {
                      userId: context.actor.userId,
                      workspaceId: context.actor.workspaceId,
                      isDefault: true,
                    },
                    orderBy: newestVoiceCredentialOrder,
                  });
              if (!found) {
                throw new ORPCError("BAD_REQUEST", { message: "Connect a voice provider first." });
              }
              // Picking a voice also makes its provider the one speak/transcribe use.
              await tx.userVoiceCredential.updateMany({
                where: {
                  userId: context.actor.userId,
                  workspaceId: context.actor.workspaceId,
                  id: { not: found.id },
                },
                data: { isDefault: false },
              });
              return tx.userVoiceCredential.update({
                where: { id: found.id },
                data: { voiceId: input.voiceId, isDefault: true },
              });
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

async function meDto(deps: RouterDeps, actor: Actor): Promise<Me> {
  const [user, cred, settings] = await Promise.all([
    deps.prisma.user.findUniqueOrThrow({ where: { id: actor.userId } }),
    findDefaultModelCredential(deps.prisma, actor),
    deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
  ]);
  const hasDeployment = Boolean(
    settings?.deploymentModelCredentialCipher || deps.env.openRouterKey,
  );
  return {
    userId: actor.userId,
    email: user.email,
    name: user.name,
    workspaceId: actor.workspaceId,
    isDeploymentOwner: actor.isDeploymentOwner,
    needsModel: !cred && !hasDeployment,
    defaultProvider: cred?.provider ?? settings?.defaultModelProvider ?? deps.env.defaultProvider,
    defaultModel: cred?.defaultModel ?? settings?.defaultModelId ?? deps.env.defaultModel,
    computerHost: computerHostFor(settings?.computerHost, deps.env.sandboxProvider),
    canChooseHostComputer: actor.isDeploymentOwner && deps.env.sandboxProvider === "docker",
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
  return toComputerStatus(botId, bot.computer);
}

async function expireStaleComputerControl(
  deps: RouterDeps,
  computer:
    | (NonNullable<Parameters<typeof hasActiveComputerControl>[0]> & { id: string })
    | null
    | undefined,
): Promise<boolean> {
  const leaseId = computer?.controlLeaseId;
  if (!leaseId || hasActiveComputerControl(computer)) return false;
  await expireComputerControl(deps, computer.id, leaseId).catch(() => undefined);
  return true;
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
  if (!lease || lease.expiresAt.getTime() <= Date.now()) return context;
  return { ...context, screenLeaseId: screenLeaseIdForRun(lease, lease.runId) };
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
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    signal: input.signal ?? new AbortController().signal,
  });
  throwIfAborted(input.signal);
  const cred = await withSerializableRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        throwIfAborted(input.signal);
        const existing = await tx.userModelCredential.findFirst({
          where: {
            userId: actor.userId,
            workspaceId: actor.workspaceId,
            provider: input.provider,
          },
          orderBy: newestModelCredentialOrder,
        });
        throwIfAborted(input.signal);
        const secret = await tx.secret.create({
          data: {
            id: stored.id,
            userId: actor.userId,
            workspaceId: actor.workspaceId,
            kind: "model",
            ciphertext: stored.ciphertext,
          },
        });
        throwIfAborted(input.signal);
        await tx.userModelCredential.updateMany({
          where: { userId: actor.userId, workspaceId: actor.workspaceId },
          data: { isDefault: false },
        });
        throwIfAborted(input.signal);
        if (!existing) {
          const created = await tx.userModelCredential.create({
            data: {
              userId: actor.userId,
              workspaceId: actor.workspaceId,
              provider: input.provider,
              label: input.label ?? input.provider,
              secretId: secret.id,
              isDefault: true,
              defaultModel: input.modelId ?? deps.env.defaultModel,
            },
          });
          throwIfAborted(input.signal);
          return created;
        }
        const updated = await tx.userModelCredential.update({
          where: { id: existing.id },
          data: {
            label: input.label ?? input.provider,
            secretId: secret.id,
            isDefault: true,
            defaultModel: input.modelId ?? deps.env.defaultModel,
          },
        });
        throwIfAborted(input.signal);
        const sharedSecret = await tx.userModelCredential.count({
          where: { id: { not: existing.id }, secretId: existing.secretId },
        });
        throwIfAborted(input.signal);
        if (sharedSecret === 0) {
          await tx.secret.deleteMany({ where: { id: existing.secretId } });
          throwIfAborted(input.signal);
        }
        return updated;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return modelCredentialDto(cred, input.plaintext);
}

async function requireWorkspaceOwner(prisma: PrismaClient, actor: Actor): Promise<void> {
  const member = await prisma.member.findFirst({
    where: {
      organizationId: actor.workspaceId,
      userId: actor.userId,
    },
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
  await requireWorkspaceOwner(deps.prisma, actor);
  const prepared = await prepareMemoryProviderConnection(input).catch((error: unknown) => {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Memory provider connection failed",
    });
  });
  const stored = await deps.secrets.put(JSON.stringify(prepared.credentials), {
    operationId: "memory-provider-config",
    traceId: "memory-provider-config",
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    signal: new AbortController().signal,
  });
  const config = await withSerializableRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const existing = await findWorkspaceMemoryConfig(tx, actor.workspaceId);
        const secret = await tx.secret.create({
          data: {
            id: stored.id,
            userId: actor.userId,
            workspaceId: actor.workspaceId,
            kind: "memory-provider",
            ciphertext: stored.ciphertext,
          },
        });
        const updated = await tx.workspaceMemoryConfig.upsert({
          where: { workspaceId: actor.workspaceId },
          create: {
            workspaceId: actor.workspaceId,
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
  return serializeWorkspaceMemoryConfig(config);
}

export async function updateMemoryProviderDefaultScope(
  deps: RouterDeps,
  actor: Actor,
  defaultMemoryScope: "isolated" | "shared",
) {
  await requireWorkspaceOwner(deps.prisma, actor);
  const existing = await findWorkspaceMemoryConfig(deps.prisma, actor.workspaceId);
  if (!existing) throw new ORPCError("NOT_FOUND");
  const updated = await deps.prisma.workspaceMemoryConfig.update({
    where: { id: existing.id },
    data: { defaultMemoryScope },
  });
  return serializeWorkspaceMemoryConfig(updated);
}

function serializeWorkspaceMemoryConfig(config: {
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

function nextRoutineDate(cron: string, timezone: string): Date {
  try {
    return nextCronDate(cron, new Date(), timezone);
  } catch {
    throw new ORPCError("BAD_REQUEST", { message: "Enter a valid cron expression." });
  }
}

function mapRoutine(row: {
  id: string;
  botId: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  active: boolean;
  notify: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    botId: row.botId,
    name: row.name,
    prompt: row.prompt,
    cron: row.cron,
    timezone: row.timezone,
    active: row.active,
    notify: row.notify,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function listRoutinesDto(deps: RouterDeps, actor: Actor, botId: string) {
  const rows = await deps.prisma.routine.findMany({
    where: { botId, workspaceId: actor.workspaceId },
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
