import { randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { getBotSecretMetadata } from "@rakazo/adapters";
import {
  archiveBot,
  checkpointAndStopComputer,
  forgetBotSecret,
  hasActiveComputerControl,
  listBotSecretMetadata,
  normalizeSecretDestination,
  pageUrlOrigin,
  revealBotSecret,
  SPACE_VAULT_NOT_IN_USE,
  stopCancelledGroupRuns,
  storeBotSecret,
  toComputerRef,
  validateBotModelChange,
} from "@rakazo/adapters";
import type {
  Actor,
  Bot,
  BotSecretMetadata,
  SettingsScope,
  VaultPutInput,
} from "@rakazo/contracts";
import { BotSecretAuth, resolveBotAvatarSet } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, displayName } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import {
  BotSectionNameConflictError,
  botProfileLabelsChanged,
  ComputerLimitError,
  commitBotUpdate,
  expireComputerExecutionLeases,
  InstructionConflictError,
  IsolationError,
  recordComputerRunEnd,
  recordSecurityEvent,
  restoreBotUnderComputerQuota,
  SpaceDeletionInProgressError,
  settingsTarget,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { AgentImportServices } from "../agent-import.js";
import { agentImportSetupState, createImportedBot, previewAgentImport } from "../agent-import.js";
import { deleteAgentSecret, listAgentSecrets, putAgentSecret } from "../agent-secrets.js";
import { changedBotSettings } from "../bot-setting-analytics.js";
import { requireIdentityConfirmation } from "../identity-confirmation.js";
import type { RouterDeps } from "../router.js";
import { loadMessagePage } from "../thread-message-pages.js";
import type { RouterContext } from "./context.js";
import {
  computerContext,
  isRecordNotFound,
  modelSetup,
  THREAD_MESSAGE_PAGE_SIZE,
} from "./shared.js";

/** Surface a Space deletion race as a retryable conflict instead of a generic failure. */
function mapSpaceLifecycleError(error: unknown): unknown {
  if (error instanceof SpaceDeletionInProgressError) {
    return new ORPCError("CONFLICT", { message: error.message });
  }
  if (error instanceof ComputerLimitError) {
    return new ORPCError("BAD_REQUEST", { message: error.message });
  }
  return error;
}

const BOT_SECRET_INPUT_ERRORS = [
  "Invalid credential destination",
  "Invalid credential length",
  "Credential cannot be used with this authentication method",
  "Remove the existing credential before changing its destination",
  "Credential limit reached",
  SPACE_VAULT_NOT_IN_USE,
];

/** A credential the user typed that cannot be stored, as a bad request. Never echoes the value. */
export function mapBotSecretInputError(error: unknown): unknown {
  if (
    error instanceof Error &&
    BOT_SECRET_INPUT_ERRORS.some((prefix) => error.message.startsWith(prefix))
  ) {
    return new ORPCError("BAD_REQUEST", { message: error.message });
  }
  return error;
}

/** Map credential validation failures to a bad request without echoing the submitted value. */
function mapBotSecretStoreError(error: unknown): unknown {
  if (error instanceof ORPCError) return error;
  const mapped = mapBotSecretInputError(error);
  if (mapped !== error) return mapped;
  // Login decoding failures: a JSON parse message can quote the submitted value, so never forward it.
  if (error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError")) {
    return new ORPCError("BAD_REQUEST", {
      message: "A website login needs a label and a value for every field",
    });
  }
  return error;
}

function vaultScope(actor: Actor, vault?: SettingsScope) {
  return { userId: actor.userId, spaceId: actor.spaceId, vault };
}

async function saveVaultCredential(
  deps: RouterDeps,
  scope: ReturnType<typeof vaultScope>,
  input: Pick<VaultPutInput, "destination" | "value">,
) {
  // A pasted page URL is saved under its site. One with a username or password is left
  // as typed, so the origin rule turns it down and the person can fix it.
  const site = pageUrlOrigin(input.destination.origin, { allowUserinfo: false, maxLength: 2048 });
  let row: Awaited<ReturnType<typeof getBotSecretMetadata>>;
  try {
    row = await storeBotSecret({
      prisma: deps.prisma,
      secretStore: deps.secrets,
      scope,
      destination: site ? { ...input.destination, origin: site } : input.destination,
      plaintext: input.value,
    });
  } catch (error) {
    throw mapBotSecretStoreError(error);
  }
  if (!row) throw new ORPCError("CONFLICT", { message: "Credential was not saved" });
  return botSecretMetadataDto(row);
}

function botSecretMetadataDto(row: {
  name: string;
  origin: string;
  auth: unknown;
  createdAt: Date;
  updatedAt: Date;
}): BotSecretMetadata {
  // Unreadable or no-longer-storable destinations become auth:null so the owner UI stays remove-only.
  const parsed = BotSecretAuth.safeParse(row.auth);
  let auth: BotSecretMetadata["auth"] = null;
  if (parsed.success) {
    try {
      normalizeSecretDestination({ name: row.name, origin: row.origin, auth: parsed.data });
      auth = parsed.data;
    } catch {
      auth = null;
    }
  }
  return {
    name: row.name,
    origin: row.origin,
    auth,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The creation intro's hidden prompt. It names only the tools this bot still has. */
export function botIntroPrompt(input: {
  userName: string;
  spaceName: string | null;
  disabledBuiltinTools: readonly string[];
}): string {
  const canAsk = !input.disabledBuiltinTools.includes("ask_user");
  const canUpdate = !input.disabledBuiltinTools.includes("update_bot");
  const options =
    "two to four short options that fit your name, anything your description or instructions already say, and what you know about them, never a stock list";
  return [
    [
      "You were just created.",
      input.userName ? `${input.userName} made you.` : undefined,
      input.spaceName ? `Their team space is called "${input.spaceName}".` : undefined,
    ]
      .filter(Boolean)
      .join(" "),
    // Text streamed before ask_user is not kept once the run pauses, so the greeting
    // goes in the question itself.
    canAsk
      ? `Call ask_user right away, with no text before it. Its question greets them by first name in a few words and asks what they want you for, with ${options}. They can also type their own answer.`
      : `Greet them by first name in a few words and ask in one sentence what they want you for, suggesting ${options}.`,
    "If your profile already makes that clear, say in one line what you will do instead of asking.",
    canUpdate
      ? 'Once you know what you are for, use update_bot to set what is already clear: a one-line description of what you do, your instructions on how you do it, and a short name if yours is still a placeholder like "New Bot". Leave anything vague unset to fill in later as the work becomes clearer, and otherwise keep your name and look.'
      : undefined,
    "Then get started, asking one follow-up only if you cannot start without it.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Creating a bot asks only for a name and a look, so one hidden-prompt turn greets the user and
 * asks what the bot is for. The executor limits the "created" trigger to that question and the
 * bot's own profile, and answering resumes the run as the user's turn.
 */
export async function enqueueBotIntroRun(deps: RouterDeps, actor: Actor, bot: Bot): Promise<void> {
  const threadId = bot.threadId;
  if (!threadId) return;
  // In the scripted test/eval runtime an automatic run would compete with the harness's next
  // queued response.
  if (deps.env.agentRuntime === "scripted") return;
  if ((await modelSetup(deps, actor)).needsModel) return;
  const [user, space] = await Promise.all([
    deps.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } }),
    deps.prisma.space.findUnique({
      where: { id: actor.spaceId },
      select: { name: true, isDefault: true },
    }),
  ]);
  const prompt = botIntroPrompt({
    userName: displayName(user?.name, ""),
    spaceName: space && !space.isDefault ? space.name.trim() || null : null,
    disabledBuiltinTools: bot.disabledBuiltinTools ?? [],
  });
  const run = await deps.prisma.$transaction(async (tx) => {
    // An idempotent create (spawnKey) returns the bot it already made; it gets one intro.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
    if (await tx.run.findFirst({ where: { botId: bot.id }, select: { id: true } })) return null;
    const task = await tx.task.create({
      data: {
        spaceId: actor.spaceId,
        botId: bot.id,
        threadId,
        userId: actor.userId,
        prompt,
        status: "queued",
      },
    });
    return tx.run.create({
      data: {
        spaceId: actor.spaceId,
        botId: bot.id,
        threadId,
        taskId: task.id,
        userId: actor.userId,
        status: "queued",
        trigger: "created",
      },
      select: { id: true },
    });
  });
  if (run) await deps.jobs.enqueue(runContinueJob(run.id));
}

export function botsRoutes(ctx: RouterContext) {
  const { deps, repos, botModelValidation, removeBot, agentImportServices, groupRepos, authed } =
    ctx;
  return {
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
      create: authed.bots.create.handler(async ({ context, input }) => {
        let bot: Bot;
        try {
          bot = await repos.createBot(context.actor, input);
        } catch (error) {
          throw mapSpaceLifecycleError(error);
        }
        await enqueueBotIntroRun(deps, context.actor, bot).catch((error) => {
          getLogger().error("bot intro run enqueue", error);
        });
        return bot;
      }),
      importPreview: authed.bots.importPreview.handler(async ({ context, input }) =>
        previewAgentImport(agentImportServices as AgentImportServices, context.actor, input),
      ),
      importCreate: authed.bots.importCreate.handler(async ({ context, input }) => {
        let bot: Bot;
        try {
          bot = await createImportedBot(agentImportServices, context.actor, input, context.signal);
        } catch (error) {
          throw mapSpaceLifecycleError(error);
        }
        // An imported bot starts inert: no intro run, paused routines, unapproved servers.
        return bot;
      }),
      importSetupState: authed.bots.importSetupState.handler(async ({ context, input }) =>
        agentImportSetupState(agentImportServices as AgentImportServices, context.actor, input),
      ),
      duplicate: authed.bots.duplicate.handler(async ({ context, input }) => {
        const source = await repos.getBot(context.actor, input.botId);
        const duplicate = await repos
          .createBot(context.actor, {
            name: duplicateBotName(source.name),
            description: source.description,
            instructions: source.instructions,
            notifyOnFinish: source.notifyOnFinish,
            color: source.color,
            avatarSet: resolveBotAvatarSet(source.avatarSet),
            computerMode: source.computer?.scope === "dedicated" ? "dedicated" : "team",
            modelProvider: source.modelProvider,
            modelId: source.modelId,
            thinkingLevel: source.thinkingLevel,
            disabledBuiltinTools: source.disabledBuiltinTools,
          })
          .catch((error: unknown) => {
            throw mapSpaceLifecycleError(error);
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
        const modelChange = await validateBotModelChange(botModelValidation(context.actor), {
          userId: context.actor.userId,
          spaceId: context.actor.spaceId,
          provider:
            input.modelProvider !== undefined ? input.modelProvider : existing.modelProvider,
          model: input.modelId !== undefined ? input.modelId : existing.modelId,
          thinkingLevel: input.thinkingLevel,
          current: { provider: existing.modelProvider, model: existing.modelId },
        });
        if (!modelChange.ok) throw new ORPCError("BAD_REQUEST", { message: modelChange.error });
        const thinkingLevel = input.thinkingLevel;
        if (!existing.thread) throw new IsolationError();
        await commitBotUpdate({
          prisma: deps.prisma,
          notify: (threadId, seq) => deps.events.notify(threadId, seq),
          spaceId: context.actor.spaceId,
          threadId: existing.thread.id,
          botId: input.botId,
          emitBotUpdated: botProfileLabelsChanged(input) || input.expectedSettings !== undefined,
          expectedInstructions: input.expectedInstructions,
          expectedSettings: input.expectedSettings,
          data: {
            name: input.name,
            description: input.description,
            instructions: input.instructions,
            notifyOnFinish: input.notifyOnFinish,
            color: input.color,
            avatarSet: input.avatarSet,
            pinned: input.pinned,
            memoryScope: input.memoryScope,
            sectionId: input.sectionId,
            voiceId: input.voiceId,
            autoSpeak: input.autoSpeak,
            ...(input.modelProvider !== undefined
              ? { modelProvider: input.modelProvider, modelId: input.modelId ?? null }
              : {}),
            ...(input.thinkingLevel !== undefined ? { thinkingLevel } : {}),
            ...(input.teamChatAmbientEnabled !== undefined
              ? { teamChatAmbientEnabled: input.teamChatAmbientEnabled }
              : {}),
            ...(input.teamChatRules !== undefined ? { teamChatRules: input.teamChatRules } : {}),
            ...(input.crossSpaceCommunication !== undefined
              ? { crossSpaceCommunication: input.crossSpaceCommunication }
              : {}),
            ...(input.fleetManagement !== undefined
              ? { fleetManagement: input.fleetManagement }
              : {}),
            ...(input.disabledBuiltinTools !== undefined
              ? { disabledBuiltinTools: input.disabledBuiltinTools }
              : {}),
          },
        }).catch((error) => {
          if (input.expectedSettings && isRecordNotFound(error))
            throw new ORPCError("CONFLICT", {
              message: "Settings changed; review the current settings first.",
            });
          if (!(error instanceof InstructionConflictError)) throw error;
          throw new ORPCError("CONFLICT", { message: error.message });
        });
        for (const setting of changedBotSettings(existing, input)) {
          deps.analytics?.capture(context.actor.userId, { name: "bot_setting_changed", setting });
        }
        const bots = await repos.listBots(context.actor);
        const bot = bots.find((b) => b.id === input.botId);
        if (!bot) throw new IsolationError();
        return bot;
      }),
      restoreInstructions: authed.bots.restoreInstructions.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.thread) throw new IsolationError();
        try {
          await commitBotUpdate({
            prisma: deps.prisma,
            notify: (threadId, seq) => deps.events.notify(threadId, seq),
            spaceId: context.actor.spaceId,
            threadId: bot.thread.id,
            botId: bot.id,
            data: {},
            emitBotUpdated: true,
            expectedInstructions: input.expectedInstructions,
            instructionRestore: { versionId: input.versionId, undo: input.undo },
          });
        } catch (error) {
          if (!(error instanceof InstructionConflictError)) throw error;
          throw new ORPCError("CONFLICT", { message: error.message });
        }
        return (await repos.listBots(context.actor)).find((bot) => bot.id === input.botId)!;
      }),
      setComputer: authed.bots.setComputer.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        const currentMode = bot.computer.scope === "dedicated" ? "dedicated" : "team";
        if (currentMode === input.mode) {
          try {
            return await repos.setBotComputer(context.actor, bot.id, input.mode);
          } catch (error) {
            throw mapSpaceLifecycleError(error);
          }
        }
        const claimed = await deps.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM computers WHERE id = ${bot.computerId} FOR UPDATE`;
          return tx.bot.updateMany({
            where: { id: bot.id, computerSwitching: false, computer: { maintenanceId: null } },
            data: { computerSwitching: true },
          });
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
              await checkpointAndStopComputer(deps, bot.computer, ref, ctx);
            }
            await expireComputerExecutionLeases(deps.prisma, {
              computerId: bot.computer.id,
              botId: bot.id,
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
            await recordComputerRunEnd(deps.prisma, bot.computer, "stopped");
          }
          const updated = await repos.setBotComputer(context.actor, bot.id, input.mode);
          deps.analytics?.capture(context.actor.userId, {
            name: "bot_setting_changed",
            setting: "computer",
          });
          return updated;
        } catch (error) {
          throw mapSpaceLifecycleError(error);
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
        try {
          if (bot.computer) {
            await restoreBotUnderComputerQuota(deps.prisma, {
              userId: context.actor.userId,
              botId: bot.id,
              computerId: bot.computer.id,
            });
          } else {
            await deps.prisma.bot.update({ where: { id: bot.id }, data: { archivedAt: null } });
          }
        } catch (error) {
          throw mapSpaceLifecycleError(error);
        }
        return { ok: true as const };
      }),
      remove: authed.bots.remove.handler(async ({ context, input }) => {
        await removeBot(context.actor, input.botId, { deleteMemories: input.deleteMemories });
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
      create: authed.groups.create.handler(async ({ context, input }) => {
        try {
          return await groupRepos.createGroup(context.actor, input);
        } catch (error) {
          throw mapSpaceLifecycleError(error);
        }
      }),
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
        try {
          return await groupRepos.createGroup(context.actor, {
            name: duplicateBotName(source.name),
            botIds: source.members.map((member) => member.bot.id),
          });
        } catch (error) {
          throw mapSpaceLifecycleError(error);
        }
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
        await stopCancelledGroupRuns(deps, context.actor, updated);
        return updated.group;
      }),
      archive: authed.groups.archive.handler(async ({ context, input }) => {
        const archived = await groupRepos.archiveGroup(context.actor, input.groupId);
        await stopCancelledGroupRuns(deps, context.actor, archived);
        return { ok: true as const };
      }),
      restore: authed.groups.restore.handler(async ({ context, input }) => {
        try {
          await groupRepos.restoreGroup(context.actor, input.groupId);
        } catch (error) {
          throw mapSpaceLifecycleError(error);
        }
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
          if (result.status === "rejected")
            getLogger().error("group artifact cleanup", result.reason);
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
      update: authed.botSections.update.handler(async ({ context, input }) => {
        try {
          return await repos.updateBotSection(context.actor, input);
        } catch (error) {
          if (error instanceof BotSectionNameConflictError) {
            throw new ORPCError("CONFLICT", { message: error.message });
          }
          throw error;
        }
      }),
      remove: authed.botSections.remove.handler(async ({ context, input }) =>
        repos.deleteBotSection(context.actor, input),
      ),
    },
    agentSecrets: {
      list: authed.agentSecrets.list.handler(async ({ context }) =>
        listAgentSecrets({ prisma: deps.prisma, secrets: deps.secrets }, context.actor),
      ),
      put: authed.agentSecrets.put.handler(async ({ context, input }) =>
        putAgentSecret({ prisma: deps.prisma, secrets: deps.secrets }, context.actor, input),
      ),
      remove: authed.agentSecrets.remove.handler(async ({ context, input }) =>
        deleteAgentSecret({ prisma: deps.prisma, secrets: deps.secrets }, context.actor, input.id),
      ),
    },
    vault: {
      list: authed.vault.list.handler(async ({ context, input }) => {
        const rows = await listBotSecretMetadata(
          deps.prisma,
          vaultScope(context.actor, input?.scope),
        );
        return rows.map(botSecretMetadataDto);
      }),
      put: authed.vault.put.handler(({ context, input }) =>
        saveVaultCredential(deps, vaultScope(context.actor, input.scope), input),
      ),
      reveal: authed.vault.reveal.handler(async ({ context, input }) => {
        await requireIdentityConfirmation(deps.auth, context);
        // Resolved here, so the event names the vault that was read even when scope is omitted.
        const scope = await settingsTarget(deps.prisma, context.actor, "credentials", input.scope);
        const revealed = await revealBotSecret({
          prisma: deps.prisma,
          secretStore: deps.secrets,
          scope: vaultScope(context.actor, scope),
          name: input.name,
        });
        if (!revealed) throw new ORPCError("NOT_FOUND", { message: "Credential not found" });
        await recordSecurityEvent({
          type: "credential.revealed",
          userId: context.actor.userId,
          spaceId: context.actor.spaceId,
          metadata: {
            procedure: "vault.reveal",
            kind: "vault_credential",
            scope,
            name: input.name,
          },
        });
        return revealed;
      }),
      remove: authed.vault.remove.handler(async ({ context, input }) => {
        await forgetBotSecret(deps.prisma, vaultScope(context.actor, input.scope), input.name);
        return { ok: true as const };
      }),
    },
    botSecrets: {
      list: authed.botSecrets.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        const rows = await listBotSecretMetadata(deps.prisma, vaultScope(context.actor));
        return rows.map(botSecretMetadataDto);
      }),
      put: authed.botSecrets.put.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return saveVaultCredential(deps, vaultScope(context.actor), input);
      }),
      remove: authed.botSecrets.remove.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        await forgetBotSecret(deps.prisma, vaultScope(context.actor), input.name);
        return { ok: true as const };
      }),
    },
  };
}

function duplicateBotName(name: string) {
  const label = displayName(name, "");
  return label ? `${label.slice(0, 75)} copy` : "";
}
