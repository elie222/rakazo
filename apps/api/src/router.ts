import { randomUUID } from "node:crypto";
import { implement, ORPCError } from "@orpc/server";
import {
  type AdapterContext,
  type AgentHomeStore,
  type ArtifactStore,
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
  type ComposioProvider,
  ComputerBusyError,
  type ComputerExecutionLease,
  checkpointAndRecordComputerWorkspace,
  createVoiceProvider,
  deleteSupermemoryContainer,
  destroyBot,
  displayBotWorkspacePath,
  type EncryptedSecretStore,
  expireComputerControl,
  hasActiveComputerControl,
  isSupermemoryEnabled,
  listPiCatalog,
  type PiOAuthLogins,
  planLiveConnectionSync,
  provisionComputer,
  releaseComputerExecutionLease,
  resolveBotWorkspacePath,
  sanitizeComposioError,
  savePushToken,
  scheduleComputerControlExpiry,
  scheduleComputerSleep,
  screenLeaseIdForRun,
  scriptedCatalogEntry,
  serializeModelSecret,
  supermemoryContainerTag,
  takeoverLeaseMs,
  toComputerRef,
  touchRunningComputer,
} from "@rakazo/adapters";
import type { Auth } from "@rakazo/auth";
import { type Actor, appContract, type ComputerStatus, type Me } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, AttachmentValidationError, nextCronDate } from "@rakazo/core";
import {
  appendEventInTransaction,
  createGroupRepos,
  createRepos,
  createThreadMessageInTransaction,
  findDefaultModelCredential,
  findDefaultVoiceCredential,
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

async function reconcilePendingComposioConnections(
  prisma: PrismaClient,
  owner: Pick<Actor, "workspaceId" | "userId">,
  connectedProviders: string[],
): Promise<void> {
  const rows = await prisma.connection.findMany({
    where: {
      workspaceId: owner.workspaceId,
      userId: owner.userId,
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

export interface RouterDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  auth: Auth;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
  memory: MemoryStore;
  home: AgentHomeStore;
  secrets: EncryptedSecretStore;
  oauthLogins: PiOAuthLogins;
  composio?: ComposioProvider;
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
        return rows.map((row) => ({
          id: row.id,
          provider: row.provider,
          label: row.label,
          hasKey: true,
          isDefault: row.isDefault,
        }));
      }),
      connect: authed.models.connect.handler(async ({ context, input }) => {
        return persistModelCredential(deps, context.actor, {
          provider: input.provider,
          plaintext: input.apiKey,
          label: input.label,
          modelId: input.modelId,
          signal: context.signal,
        });
      }),
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
        return repos.createBot(context.actor, {
          name: duplicateBotName(source.name),
          title: source.title,
          description: source.description,
          instructions: source.instructions,
          notifyOnFinish: source.notifyOnFinish,
          color: source.color,
          computerMode: source.computer?.scope === "dedicated" ? "dedicated" : "team",
        });
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
        await Promise.all(
          cancelledRunIds.map((runId) => deps.jobs.cancel(runJobKey(runId)).catch(() => undefined)),
        );
        if (isSupermemoryEnabled(process.env.SUPERMEMORY_API_KEY)) {
          // Best effort: the conversation rows are already deleted, so failing the clear here
          // would help nothing — a failed purge only leaves stale summaries recallable.
          const tags = [
            ...new Set([
              supermemoryContainerTag(bot.id),
              supermemoryContainerTag(bot.id, historyCompactionGeneration),
            ]),
          ];
          await Promise.all(
            tags.map(async (tag) => {
              const purged = await deleteSupermemoryContainer(tag);
              if (!purged.ok) {
                console.error("supermemory purge after thread clear failed", purged.error);
              }
            }),
          );
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
            payload: { leaseId },
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
          leaseId: controlLeaseId,
          holder: "bot",
          reason: "released",
        });
        if (!released) return { ok: true as const };
        // The lease-specific key makes this cancellation safe after a replacement takeover.
        await deps.jobs.cancel(computerControlExpireJobKey(bot.computer.id, controlLeaseId));

        const waiting = await deps.prisma.run.findFirst({
          where: { botId: controlBotId, status: "waiting_takeover" },
          orderBy: { createdAt: "desc" },
        });
        if (waiting) await deps.jobs.enqueue(runContinueJob(waiting.id));
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
    },
    routines: {
      list: authed.routines.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return listRoutinesDto(deps, context.actor, input.botId);
      }),
      create: authed.routines.create.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
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
            nextRunAt: input.active ? nextCronDate(input.cron, new Date(), input.timezone) : null,
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
        const scheduleChanged =
          (!existing.active && active) ||
          (input.cron !== undefined && input.cron !== existing.cron) ||
          (input.timezone !== undefined && input.timezone !== existing.timezone);
        const nextRunAt = !active
          ? null
          : scheduleChanged || !existing.nextRunAt
            ? nextCronDate(cron, new Date(), timezone)
            : existing.nextRunAt;
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
          kind: row.kind as "skill" | "plugin" | "mcp" | "connection",
          name: row.name,
          source: row.source,
          version: row.version,
          digest: row.digest,
          config: row.config as Record<string, unknown>,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      install: authed.capabilities.install.handler(async ({ context, input }) => {
        const row = await deps.prisma.capabilityInstall.create({
          data: {
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
            kind: input.kind,
            name: input.name,
            source: input.source,
            config: input.config as Prisma.InputJsonValue,
            digest: "sha256:local",
            version: "0.0.0",
          },
        });
        return {
          id: row.id,
          kind: row.kind as "skill" | "plugin" | "mcp" | "connection",
          name: row.name,
          source: row.source,
          version: row.version,
          digest: row.digest,
          config: row.config as Record<string, unknown>,
          createdAt: row.createdAt.toISOString(),
        };
      }),
      remove: authed.capabilities.remove.handler(async ({ context, input }) => {
        await deps.prisma.capabilityInstall.deleteMany({
          where: {
            id: input.id,
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
          },
        });
        return { ok: true as const };
      }),
    },
    connections: {
      catalog: authed.connections.catalog.handler(async ({ context, input }) => {
        if (!deps.composio) return [];
        try {
          const items = await deps.composio.catalog(context.actor.userId, input.query);
          const nowConnected = items.filter((item) => item.connected).map((item) => item.slug);
          if (nowConnected.length > 0) {
            // A connection can finish on Composio's side after our own completion check gave
            // up (see PluginsOverlay's polling timeout) — reconcile stale "pending" rows here
            // so callers like the run executor, which trust our local status, stay in sync.
            // Reuse the executor's one-row-per-provider plan so duplicate auth attempts do not
            // leave stale locally connected rows behind after a later revoke.
            // Best effort: a failed reconciliation write shouldn't blank out an otherwise
            // successful catalog fetch — the caller still gets accurate, if unreconciled, data.
            await reconcilePendingComposioConnections(
              deps.prisma,
              context.actor,
              nowConnected,
            ).catch((error) => {
              console.error("composio pending-connection reconciliation failed", error);
            });
          }
          return items;
        } catch {
          return [];
        }
      }),
      list: authed.connections.list.handler(async ({ context }) => {
        const rows = await deps.prisma.connection.findMany({
          where: { workspaceId: context.actor.workspaceId, userId: context.actor.userId },
        });
        return rows.map((row) => ({
          id: row.id,
          provider: row.provider,
          displayName: row.displayName,
          status: row.status as "pending" | "connected" | "revoked" | "error",
          capabilities: [],
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      begin: authed.connections.begin.handler(async ({ context, input }) => {
        const row = await deps.prisma.connection.create({
          data: {
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
            provider: input.provider,
            displayName: input.displayName,
            status: "pending",
          },
        });
        if (!deps.composio) {
          return { connectionId: row.id, authorizationUrl: null };
        }
        try {
          const auth = await deps.composio.begin(
            { provider: input.provider, redirectUrl: `${deps.env.webOrigin}/app` },
            {
              operationId: "connections.begin",
              traceId: "connections.begin",
              workspaceId: context.actor.workspaceId,
              userId: context.actor.userId,
              signal: new AbortController().signal,
            },
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
        if (deps.composio) {
          const ready = await deps.composio.connectionReady(
            context.actor.userId,
            existing.provider,
          );
          if (ready) {
            await deps.prisma.connection.update({
              where: { id: existing.id },
              data: { status: "connected" },
            });
          }
        } else {
          await deps.prisma.connection.update({
            where: { id: existing.id },
            data: { status: "connected" },
          });
        }
        const row = await deps.prisma.connection.findFirstOrThrow({ where: { id: existing.id } });
        return {
          id: row.id,
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
        if (row && deps.composio) {
          await deps.composio.revoke(row.provider, {
            operationId: "connections.revoke",
            traceId: "connections.revoke",
            workspaceId: context.actor.workspaceId,
            userId: context.actor.userId,
            signal: new AbortController().signal,
          });
        }
        await deps.prisma.connection.updateMany({
          where: { id: input.connectionId, workspaceId: context.actor.workspaceId },
          data: { status: "revoked" },
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
  return {
    id: cred.id,
    provider: cred.provider,
    label: cred.label,
    hasKey: true,
    isDefault: true,
  };
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error("Request cancelled");
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
