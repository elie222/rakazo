import type {
  Actor,
  Bot,
  BotAvatarSet,
  BotSection,
  MessageBlock,
  SpaceBot,
} from "@rakazo/contracts";
import {
  canonicalPiProviderId,
  DEFAULT_NEW_BOT_AVATAR_SET,
  InstructionVersionSchema,
  initialBotMemory,
  resolveBotAvatarSet,
} from "@rakazo/contracts";
import {
  BACKGROUND_RUN_TRIGGERS,
  displayName,
  isBackgroundRunTrigger,
  phoneCallSettings,
  ringingCall,
  userVisibleMessages,
} from "@rakazo/core";
import { chooseBotAvatar } from "./bot-avatar-choice.js";
import type { Prisma, PrismaClient } from "./client.js";
import type { ComputerMode } from "./computers.js";
import { ensureComputerRecord, parseComputerMode } from "./computers.js";
import { createThreadMessageInTransaction } from "./messages.js";
import { withNewestThreadMessages } from "./preview-messages.js";
import { BotSectionNameConflictError, IsolationError } from "./scope.js";
import { lockSpaceForContentCreation } from "./spaces.js";
import {
  activeRunSelection,
  previewFromBlocks,
  primaryActiveRun,
  withLatestBotRuns,
} from "./thread-listing.js";
import { withTransactionRetry } from "./transaction-retry.js";

/** Newest messages loaded for sidebar preview; enough to skip a short peer-run tail. */
const SIDEBAR_PREVIEW_MESSAGE_WINDOW = 16;

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function isBotCreateConflict(error: unknown, clientId?: string): boolean {
  if (!isUniqueViolation(error)) return false;
  const target = (error as { meta?: { target?: string[] | string } }).meta?.target;
  if (target == null) return true;
  const fields = Array.isArray(target) ? target : [target];
  return fields.some(
    (field) =>
      field.includes("spawnKey") ||
      (clientId !== undefined && (field === "id" || field === "bots_pkey")),
  );
}

function rosterRunErrorId(
  latestRun: { id: string; status: string } | undefined,
  activeRun: { status: string } | undefined,
): string | null {
  if (
    latestRun?.status !== "failed" ||
    activeRun?.status === "waiting_input" ||
    activeRun?.status === "waiting_takeover"
  ) {
    return null;
  }
  return latestRun.id;
}

// Roster rows show when the chat last moved. Bot.updatedAt also moves on settings, pin,
// section and reorder writes, so the newest message's time wins when the chat has one.
function rosterUpdatedAt(newestMessage: { createdAt: Date } | undefined, botUpdatedAt: Date) {
  return newestMessage?.createdAt ?? botUpdatedAt;
}

function mapBot(
  bot: {
    id: string;
    spaceId: string;
    name: string;
    description: string;
    instructions: string;
    instructionHistory?: unknown;
    color: string;
    avatarSet?: string;
    notifyOnFinish: boolean;
    pinned: boolean;
    sectionId: string | null;
    archivedAt: Date | null;
    parentBotId: string | null;
    memoryScope: string | null;
    createdAt: Date;
    updatedAt: Date;
    thread: { id: string; unread: boolean } | null;
    computer: { scope: string } | null;
    voiceId?: string | null;
    autoSpeak?: boolean;
    modelProvider?: string | null;
    modelId?: string | null;
    thinkingLevel?: string | null;
    teamChatAmbientEnabled?: boolean;
    teamChatRules?: string;
    crossSpaceCommunication?: boolean;
    fleetManagement?: boolean;
    disabledBuiltinTools?: string[];
    webhookSecretId?: string | null;
    spawnKey?: string | null;
  },
  preview = "",
  status = "idle",
  runErrorId: string | null = null,
  updatedAt: Date = bot.updatedAt,
  incomingCall: Bot["incomingCall"] = null,
): Bot {
  if (!bot.thread) {
    throw new IsolationError("Bot is missing its thread");
  }
  return {
    id: bot.id,
    spaceId: bot.spaceId,
    name: bot.name,
    title: "",
    description: bot.description,
    instructions: bot.instructions,
    instructionHistory: InstructionVersionSchema.array().parse(bot.instructionHistory ?? []),
    color: bot.color,
    avatarSet: resolveBotAvatarSet(bot.avatarSet),
    notifyOnFinish: bot.notifyOnFinish,
    pinned: bot.pinned,
    sectionId: bot.sectionId,
    archivedAt: bot.archivedAt?.toISOString() ?? null,
    unread: bot.thread.unread,
    parentBotId: bot.parentBotId,
    memoryScope: bot.memoryScope as "isolated" | "shared" | null,
    threadId: bot.thread.id,
    preview,
    status,
    runErrorId,
    computerMode: bot.computer ? parseComputerMode(bot.computer.scope) : "team",
    createdAt: bot.createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    voiceId: bot.voiceId ?? null,
    autoSpeak: bot.autoSpeak ?? false,
    modelProvider: bot.modelProvider ? canonicalPiProviderId(bot.modelProvider) : null,
    modelId: bot.modelId ?? null,
    thinkingLevel: (bot.thinkingLevel as Bot["thinkingLevel"]) ?? null,
    teamChatAmbientEnabled: bot.teamChatAmbientEnabled ?? false,
    teamChatRules: bot.teamChatRules ?? "",
    crossSpaceCommunication: bot.crossSpaceCommunication ?? false,
    fleetManagement: bot.fleetManagement ?? false,
    disabledBuiltinTools: bot.disabledBuiltinTools ?? [],
    webhookConfigured: Boolean(bot.webhookSecretId),
    spawnKey: bot.spawnKey ?? null,
    incomingCall,
  };
}

export function createRepos(
  prisma: PrismaClient,
  capabilities: { phoneCallsEnabled?: boolean; phoneCallRingSeconds?: number } = {},
) {
  async function listBotSectionsForSpaces(
    actor: Actor,
    spaceIds: string[],
  ): Promise<Array<BotSection & { spaceId: string }>> {
    if (spaceIds.length === 0) return [];
    const sections = await prisma.botSection.findMany({
      where: { spaceId: { in: spaceIds }, userId: actor.userId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    });
    return sections.map((section) => ({
      id: section.id,
      spaceId: section.spaceId,
      name: section.name,
      position: section.position,
      createdAt: section.createdAt.toISOString(),
      updatedAt: section.updatedAt.toISOString(),
    }));
  }

  async function listSpaceBotsForSpaces(actor: Actor, spaceIds: string[]): Promise<SpaceBot[]> {
    if (spaceIds.length === 0) return [];
    const rows = await prisma.bot.findMany({
      where: {
        spaceId: { in: spaceIds },
        userId: actor.userId,
        archivedAt: null,
      },
      select: {
        id: true,
        spaceId: true,
        name: true,
        color: true,
        avatarSet: true,
        notifyOnFinish: true,
        pinned: true,
        sectionId: true,
        updatedAt: true,
        parentBotId: true,
        thread: {
          select: {
            id: true,
            unread: true,
          },
        },
        runs: activeRunSelection,
      },
      orderBy: [{ pinned: "desc" }, { position: "asc" }, { createdAt: "asc" }],
    });
    const bots = await withNewestThreadMessages(prisma, await withLatestBotRuns(prisma, rows), 1);
    return bots.map((bot) => {
      if (!bot.thread) throw new IsolationError("Bot is missing its thread");
      const activeRun = primaryActiveRun(bot.runs);
      return {
        id: bot.id,
        spaceId: bot.spaceId,
        name: bot.name,
        title: "",
        color: bot.color,
        avatarSet: resolveBotAvatarSet(bot.avatarSet),
        notifyOnFinish: bot.notifyOnFinish,
        pinned: bot.pinned,
        sectionId: bot.sectionId,
        unread: bot.thread.unread,
        parentBotId: bot.parentBotId,
        preview: previewFromBlocks(bot.thread.messages[0]?.blocks),
        status: activeRun?.status ?? "idle",
        runErrorId: rosterRunErrorId(bot.thread.runs[0], activeRun),
        updatedAt: rosterUpdatedAt(bot.thread.messages[0], bot.updatedAt).toISOString(),
      };
    });
  }

  return {
    async listBotSections(actor: Actor): Promise<BotSection[]> {
      return listBotSectionsForSpaces(actor, [actor.spaceId]);
    },

    listBotSectionsForSpaces,

    async createBotSection(
      actor: Actor,
      input: { botId?: string; groupId?: string; name: string },
    ) {
      const { name } = input;
      return prisma.$transaction(async (tx) => {
        const target = input.botId
          ? await tx.bot.findFirst({
              where: {
                id: input.botId,
                spaceId: actor.spaceId,
                userId: actor.userId,
                archivedAt: null,
              },
              select: { id: true },
            })
          : await tx.chatGroup.findFirst({
              where: {
                id: input.groupId,
                spaceId: actor.spaceId,
                userId: actor.userId,
                archivedAt: null,
              },
              select: { id: true },
            });
        if (!target) throw new IsolationError();

        const aggregate = await tx.botSection.aggregate({
          where: { spaceId: actor.spaceId, userId: actor.userId },
          _max: { position: true },
        });
        await tx.botSection.createMany({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            name,
            position: (aggregate._max.position ?? -1) + 1,
          },
          skipDuplicates: true,
        });
        const section = await tx.botSection.findUniqueOrThrow({
          where: {
            spaceId_userId_name: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              name,
            },
          },
        });
        if (input.botId) {
          await tx.bot.update({ where: { id: target.id }, data: { sectionId: section.id } });
        } else {
          await tx.chatGroup.update({
            where: { id: target.id },
            data: { sectionId: section.id },
          });
        }
        return {
          id: section.id,
          name: section.name,
          position: section.position,
          createdAt: section.createdAt.toISOString(),
          updatedAt: section.updatedAt.toISOString(),
        } satisfies BotSection;
      });
    },

    async updateBotSection(actor: Actor, input: { sectionId: string; name: string }) {
      const existing = await prisma.botSection.findFirst({
        where: {
          id: input.sectionId,
          spaceId: actor.spaceId,
          userId: actor.userId,
        },
      });
      if (!existing) throw new IsolationError();
      if (existing.name === input.name) {
        return {
          id: existing.id,
          name: existing.name,
          position: existing.position,
          createdAt: existing.createdAt.toISOString(),
          updatedAt: existing.updatedAt.toISOString(),
        } satisfies BotSection;
      }
      try {
        const section = await prisma.botSection.update({
          where: { id: existing.id },
          data: { name: input.name },
        });
        return {
          id: section.id,
          name: section.name,
          position: section.position,
          createdAt: section.createdAt.toISOString(),
          updatedAt: section.updatedAt.toISOString(),
        } satisfies BotSection;
      } catch (error) {
        if (isUniqueViolation(error)) throw new BotSectionNameConflictError();
        throw error;
      }
    },

    /** Delete one of the actor's sections; its bots and groups stay, unsectioned (FK SetNull). */
    async deleteBotSection(actor: Actor, input: { sectionId: string }) {
      return prisma.$transaction(async (tx) => {
        // The row lock blocks concurrent moves into this section until the delete commits.
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM bot_sections
          WHERE id = ${input.sectionId}
            AND "spaceId" = ${actor.spaceId}
            AND "userId" = ${actor.userId}
          FOR UPDATE
        `;
        if (locked.length !== 1) throw new IsolationError();
        const where = { sectionId: input.sectionId };
        const releasedBots = await tx.bot.count({ where });
        const releasedGroups = await tx.chatGroup.count({ where });
        await tx.botSection.delete({ where: { id: input.sectionId } });
        return { id: input.sectionId, releasedBots, releasedGroups };
      });
    },

    async listBots(actor: Actor, options: { archived?: boolean } = {}): Promise<Bot[]> {
      const bots = await withNewestThreadMessages(
        prisma,
        await withLatestBotRuns(
          prisma,
          await prisma.bot.findMany({
            where: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              archivedAt: options.archived ? { not: null } : null,
            },
            include: {
              thread: true,
              runs: activeRunSelection,
              computer: { select: { scope: true } },
            },
            orderBy: [{ pinned: "desc" }, { position: "asc" }, { createdAt: "asc" }],
          }),
        ),
        SIDEBAR_PREVIEW_MESSAGE_WINDOW,
      );
      const callThreadIds = capabilities.phoneCallsEnabled
        ? bots.flatMap((bot) => (bot.thread ? [bot.thread.id] : []))
        : [];
      const callMessages = callThreadIds.length
        ? await prisma.message.findMany({
            where: {
              threadId: { in: callThreadIds },
              createdAt: {
                gt: new Date(
                  Date.now() -
                    (capabilities.phoneCallRingSeconds ??
                      phoneCallSettings().phoneCallRingSeconds) *
                      1000,
                ),
              },
              role: "bot",
              clientNonce: { startsWith: "call:", endsWith: ":request" },
            },
            orderBy: { seq: "desc" },
            distinct: ["threadId"],
            select: { threadId: true, role: true, blocks: true },
          })
        : [];
      const callsByThread = new Map(callMessages.map((message) => [message.threadId, message]));
      const candidateRunIds = [
        ...new Set(
          bots.flatMap((bot) =>
            (bot.thread?.messages ?? []).flatMap((message) =>
              message.runId ? [message.runId] : [],
            ),
          ),
        ),
      ];
      const checkedRunIds = new Set<string>();
      const peerRunIds = new Set<string>();
      const backgroundRunIds = new Set<string>();
      const classifyRunIds = async (ids: string[]) => {
        const missing = ids.filter((id) => !checkedRunIds.has(id));
        if (missing.length === 0) return;
        const rows = await prisma.run.findMany({
          where: {
            id: { in: missing },
            trigger: { in: ["bot_message", ...BACKGROUND_RUN_TRIGGERS] },
          },
          select: { id: true, trigger: true },
        });
        for (const row of rows) {
          if (isBackgroundRunTrigger(row.trigger)) backgroundRunIds.add(row.id);
          else peerRunIds.add(row.id);
        }
        for (const id of missing) checkedRunIds.add(id);
      };
      await classifyRunIds(candidateRunIds);
      return Promise.all(
        bots.map(async (bot) => {
          let messages = bot.thread?.messages ?? [];
          const updatedAt = rosterUpdatedAt(messages[0], bot.updatedAt);
          let preview = "";
          for (let attempt = 0; attempt < 5; attempt++) {
            const windowRunIds = [
              ...new Set(messages.flatMap((message) => (message.runId ? [message.runId] : []))),
            ].filter((runId) => !checkedRunIds.has(runId));
            if (windowRunIds.length > 0) {
              await classifyRunIds(windowRunIds);
            }
            const visible = userVisibleMessages(
              messages.map((message) => ({
                ...message,
                blocks: message.blocks as MessageBlock[],
                runId: message.runId ?? undefined,
              })),
              {
                knownPeerRunIds: peerRunIds,
                backgroundRunIds,
                includeDelegatedReplyText: false,
              },
            );
            for (const message of visible) {
              preview = previewFromBlocks(message.blocks);
              if (preview) break;
            }
            if (preview || messages.length === 0 || !bot.thread || attempt === 4) break;
            const oldest = messages[messages.length - 1];
            if (!oldest) break;
            messages = await prisma.message.findMany({
              where: { threadId: bot.thread.id, seq: { lt: oldest.seq } },
              orderBy: { seq: "desc" },
              take: SIDEBAR_PREVIEW_MESSAGE_WINDOW,
            });
            if (messages.length === 0) break;
          }
          const activeRun = primaryActiveRun(bot.runs);
          return mapBot(
            bot,
            preview,
            activeRun?.status ?? "idle",
            rosterRunErrorId(bot.thread?.runs[0], activeRun),
            updatedAt,
            ringingCall(
              bot.thread && callsByThread.has(bot.thread.id)
                ? [callsByThread.get(bot.thread.id)!]
                : [],
            ),
          );
        }),
      );
    },

    listSpaceBotsForSpaces,

    async getBot(actor: Actor, botId: string, options: { includeArchived?: boolean } = {}) {
      const bot = await prisma.bot.findFirst({
        where: {
          id: botId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          ...(options.includeArchived ? {} : { archivedAt: null }),
        },
        include: { thread: true, computer: true },
      });
      if (!bot) throw new IsolationError();
      return bot;
    },

    async createBot(
      actor: Actor,
      input: {
        id?: string;
        name: string;
        description: string;
        instructions: string;
        notifyOnFinish: boolean;
        fleetManagement?: boolean;
        color?: string;
        avatarSet?: BotAvatarSet;
        avatarFamily?: number;
        parentBotId?: string | null;
        computerMode?: ComputerMode;
        spawnKey?: string;
        modelProvider?: string | null;
        modelId?: string | null;
        thinkingLevel?: string | null;
        disabledBuiltinTools?: string[];
        initialMessage?: {
          role: "user" | "bot" | "system";
          blocks: MessageBlock[];
          runId?: string;
        };
        /** Adds content in the creation transaction, after the bot and its MEMORY.md exist. */
        seed?: (tx: Prisma.TransactionClient, botId: string) => Promise<void>;
        isolationLevel?: Prisma.TransactionIsolationLevel;
      },
    ): Promise<Bot> {
      // A reserved preview identity is also an idempotency key if the response is lost.
      const spawnKey = input.spawnKey ?? input.id;
      let modelProvider = input.modelProvider ?? null;
      let modelId = input.modelId ?? null;
      let thinkingLevel = input.thinkingLevel ?? null;
      let disabledBuiltinTools = input.disabledBuiltinTools ?? [];
      if (input.parentBotId) {
        const parent = await prisma.bot.findFirst({
          where: {
            id: input.parentBotId,
            spaceId: actor.spaceId,
            userId: actor.userId,
          },
        });
        if (!parent) throw new IsolationError();
        if (!modelId) {
          modelProvider = parent.modelProvider ?? null;
          modelId = parent.modelId ?? null;
        }
        if (thinkingLevel == null) thinkingLevel = parent.thinkingLevel ?? null;
        if (input.disabledBuiltinTools === undefined) {
          disabledBuiltinTools = parent.disabledBuiltinTools;
        }
      }
      const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
      const envKind = process.env.SANDBOX_PROVIDER ?? "docker";
      const kind =
        envKind === "docker" && settings?.computerHost === "this-mac" ? "desktop" : envKind;
      const inTransaction = <T>(run: (tx: Prisma.TransactionClient) => Promise<T>) =>
        input.isolationLevel
          ? prisma.$transaction(run, { isolationLevel: input.isolationLevel })
          : prisma.$transaction(run);
      const insertBot = () =>
        inTransaction(async (tx) => {
          await lockSpaceForContentCreation(tx, {
            spaceId: actor.spaceId,
            userId: actor.userId,
          });
          const positions = await tx.bot.aggregate({
            where: { spaceId: actor.spaceId, userId: actor.userId },
            _max: { position: true },
          });
          const avatarSet = input.avatarSet ?? DEFAULT_NEW_BOT_AVATAR_SET;
          // Only Original balances existing looks; seeded logo colours need no roster read.
          const avatar = chooseBotAvatar(
            avatarSet === "organic"
              ? await tx.bot.findMany({
                  where: { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
                  select: { id: true, color: true },
                })
              : [],
            input.color,
            { family: input.avatarFamily, avatarSet, id: input.id },
          );
          const teamComputer = await ensureComputerRecord(tx, {
            mode: "team",
            spaceId: actor.spaceId,
            userId: actor.userId,
            kind,
          });
          const created = await tx.bot.create({
            data: {
              id: avatar.id,
              spaceId: actor.spaceId,
              userId: actor.userId,
              name: displayName(input.name, ""),
              description: input.description,
              instructions: input.instructions,
              notifyOnFinish: input.notifyOnFinish,
              fleetManagement: input.fleetManagement,
              color: avatar.color,
              avatarSet,
              position: (positions._max.position ?? -1) + 1,
              parentBotId: input.parentBotId ?? null,
              computerId: teamComputer.id,
              spawnKey,
              modelProvider,
              modelId,
              thinkingLevel,
              disabledBuiltinTools,
            },
          });
          const thread = await tx.thread.create({
            data: {
              spaceId: actor.spaceId,
              botId: created.id,
              userId: actor.userId,
            },
          });
          if (input.initialMessage) {
            await createThreadMessageInTransaction(tx, {
              threadId: thread.id,
              ...input.initialMessage,
              markUnread: false,
            });
          }
          if (input.computerMode === "dedicated") {
            const dedicated = await ensureComputerRecord(tx, {
              mode: "dedicated",
              spaceId: actor.spaceId,
              userId: actor.userId,
              botId: created.id,
              kind,
            });
            await tx.bot.update({ where: { id: created.id }, data: { computerId: dedicated.id } });
          }
          await tx.browserProfile.create({
            data: {
              spaceId: actor.spaceId,
              botId: created.id,
              userId: actor.userId,
            },
          });
          await tx.memoryDocument.create({
            data: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              botId: created.id,
              scope: "bot",
              path: "MEMORY.md",
              content: initialBotMemory(input.name),
            },
          });
          await input.seed?.(tx, created.id);
          return tx.bot.findFirstOrThrow({
            where: { id: created.id },
            include: { thread: true, computer: true },
          });
        });

      const findBySpawnKey = async () => {
        if (!spawnKey) return null;
        return prisma.bot.findUnique({
          where: {
            spaceId_spawnKey: {
              spaceId: actor.spaceId,
              spawnKey,
            },
          },
          include: { thread: true, computer: true },
        });
      };

      let bot: Awaited<ReturnType<typeof insertBot>>;
      try {
        bot = await insertBot();
      } catch (error) {
        if (!spawnKey || !isBotCreateConflict(error, input.id)) throw error;
        const existing = await findBySpawnKey();
        if (
          !existing ||
          existing.userId !== actor.userId ||
          (input.id !== undefined && (existing.id !== input.id || existing.archivedAt))
        )
          throw error;
        if (!existing.archivedAt) {
          bot = existing;
        } else {
          // Free the key from the archived bot so empty-space onboarding
          // creates a fresh first bot (stale thread/runtime must not return).
          await prisma.bot.update({
            where: { id: existing.id },
            data: { spawnKey: null },
          });
          try {
            bot = await insertBot();
          } catch (retryError) {
            if (!isBotCreateConflict(retryError)) throw retryError;
            const winner = await findBySpawnKey();
            if (!winner || winner.userId !== actor.userId || winner.archivedAt) throw retryError;
            bot = winner;
          }
        }
      }
      return mapBot(bot);
    },

    async reorderBots(actor: Actor, botIds: string[]): Promise<void> {
      await prisma.$transaction(async (tx) => {
        const bots = await tx.bot.findMany({
          where: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            archivedAt: null,
          },
          select: { id: true },
        });
        const existing = new Set(bots.map((bot) => bot.id));
        if (existing.size !== botIds.length || botIds.some((id) => !existing.has(id))) {
          throw new IsolationError();
        }
        // ponytail: rosters are small; switch to one SQL CASE update only if this becomes hot.
        await Promise.all(
          botIds.map((id, position) => tx.bot.update({ where: { id }, data: { position } })),
        );
      });
    },

    async setBotComputer(actor: Actor, botId: string, mode: ComputerMode): Promise<Bot> {
      const bot = await prisma.bot.findFirst({
        where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
        include: { computer: true },
      });
      if (!bot?.computer) throw new IsolationError();
      const kind = bot.computer.kind;
      // Keep ensure + bot link in one transaction so a capped quota lock covers
      // both steps (a computer row alone does not count until a live bot refs it).
      const updated = await withTransactionRetry(() =>
        prisma.$transaction(async (tx) => {
          const computer = await ensureComputerRecord(tx, {
            mode,
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId,
            kind,
          });
          return tx.bot.update({
            where: { id: botId },
            data: { computerId: computer.id },
            include: { thread: true, computer: true },
          });
        }),
      );
      return mapBot(updated);
    },
  };
}
