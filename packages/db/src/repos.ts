import {
  type Actor,
  BOT_COLORS,
  type Bot,
  type BotSection,
  type MessageBlock,
  type SpaceBot,
} from "@rakazo/contracts";
import { userVisibleMessages } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { type ComputerMode, ensureComputerRecord, parseComputerMode } from "./computers.js";
import { createThreadMessageInTransaction } from "./messages.js";
import { IsolationError } from "./scope.js";
import { activeRunSelection, previewFromBlocks } from "./thread-listing.js";

/** Newest messages loaded for sidebar preview; enough to skip a short peer-run tail. */
const SIDEBAR_PREVIEW_MESSAGE_WINDOW = 16;

function mapBot(
  bot: {
    id: string;
    spaceId: string;
    name: string;
    title: string;
    description: string;
    instructions: string;
    color: string;
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
    webhookSecretId?: string | null;
  },
  preview = "",
  status = "idle",
): Bot {
  if (!bot.thread) {
    throw new IsolationError("Bot is missing its thread");
  }
  return {
    id: bot.id,
    spaceId: bot.spaceId,
    name: bot.name,
    title: bot.title,
    description: bot.description,
    instructions: bot.instructions,
    color: bot.color,
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
    computerMode: bot.computer ? parseComputerMode(bot.computer.scope) : "team",
    createdAt: bot.createdAt.toISOString(),
    updatedAt: bot.updatedAt.toISOString(),
    voiceId: bot.voiceId ?? null,
    autoSpeak: bot.autoSpeak ?? false,
    modelProvider: bot.modelProvider ?? null,
    modelId: bot.modelId ?? null,
    thinkingLevel: (bot.thinkingLevel as Bot["thinkingLevel"]) ?? null,
    webhookConfigured: Boolean(bot.webhookSecretId),
  };
}

export function createRepos(prisma: PrismaClient) {
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
    const bots = await prisma.bot.findMany({
      where: {
        spaceId: { in: spaceIds },
        userId: actor.userId,
        archivedAt: null,
      },
      select: {
        id: true,
        spaceId: true,
        name: true,
        title: true,
        color: true,
        notifyOnFinish: true,
        pinned: true,
        sectionId: true,
        updatedAt: true,
        thread: {
          select: {
            unread: true,
            messages: {
              orderBy: { seq: "desc" },
              take: 1,
              select: { blocks: true },
            },
          },
        },
        runs: activeRunSelection,
      },
      orderBy: [{ pinned: "desc" }, { position: "asc" }, { createdAt: "asc" }],
    });
    return bots.map((bot) => {
      if (!bot.thread) throw new IsolationError("Bot is missing its thread");
      return {
        id: bot.id,
        spaceId: bot.spaceId,
        name: bot.name,
        title: bot.title,
        color: bot.color,
        notifyOnFinish: bot.notifyOnFinish,
        pinned: bot.pinned,
        sectionId: bot.sectionId,
        unread: bot.thread.unread,
        preview: previewFromBlocks(bot.thread.messages[0]?.blocks),
        status: bot.runs[0]?.status ?? "idle",
        updatedAt: bot.updatedAt.toISOString(),
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

    async listBots(actor: Actor, options: { archived?: boolean } = {}): Promise<Bot[]> {
      const bots = await prisma.bot.findMany({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          archivedAt: options.archived ? { not: null } : null,
        },
        include: {
          thread: {
            include: {
              messages: { orderBy: { seq: "desc" }, take: SIDEBAR_PREVIEW_MESSAGE_WINDOW },
            },
          },
          runs: activeRunSelection,
          computer: { select: { scope: true } },
        },
        orderBy: [{ pinned: "desc" }, { position: "asc" }, { createdAt: "asc" }],
      });
      const candidateRunIds = [
        ...new Set(
          bots.flatMap((bot) =>
            (bot.thread?.messages ?? []).flatMap((message) =>
              message.runId ? [message.runId] : [],
            ),
          ),
        ),
      ];
      const peerRuns = candidateRunIds.length
        ? await prisma.run.findMany({
            where: { id: { in: candidateRunIds }, trigger: "bot_message" },
            select: { id: true },
          })
        : [];
      const peerRunIds = new Set(peerRuns.map((run) => run.id));
      return Promise.all(
        bots.map(async (bot) => {
          let messages = bot.thread?.messages ?? [];
          let preview = "";
          for (let attempt = 0; attempt < 5; attempt++) {
            const windowRunIds = [
              ...new Set(messages.flatMap((message) => (message.runId ? [message.runId] : []))),
            ].filter((runId) => !peerRunIds.has(runId));
            if (windowRunIds.length > 0) {
              const morePeers = await prisma.run.findMany({
                where: { id: { in: windowRunIds }, trigger: "bot_message" },
                select: { id: true },
              });
              for (const run of morePeers) peerRunIds.add(run.id);
            }
            const visible = userVisibleMessages(
              messages.map((message) => ({
                ...message,
                blocks: message.blocks as MessageBlock[],
                runId: message.runId ?? undefined,
              })),
              { knownPeerRunIds: peerRunIds },
            );
            preview = previewFromBlocks(visible[0]?.blocks);
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
          return mapBot(bot, preview, bot.runs[0]?.status ?? "idle");
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
        name: string;
        title: string;
        description: string;
        instructions: string;
        notifyOnFinish: boolean;
        color?: string;
        parentBotId?: string | null;
        computerMode?: ComputerMode;
        spawnKey?: string;
        modelProvider?: string | null;
        modelId?: string | null;
        thinkingLevel?: string | null;
        initialMessage?: {
          role: "user" | "bot" | "system";
          blocks: MessageBlock[];
          runId?: string;
        };
      },
    ): Promise<Bot> {
      let color = input.color;
      if (color === undefined) {
        const count = await prisma.bot.count({
          where: { spaceId: actor.spaceId, userId: actor.userId },
        });
        color = BOT_COLORS[count % BOT_COLORS.length] ?? BOT_COLORS[0];
      }
      let modelProvider = input.modelProvider ?? null;
      let modelId = input.modelId ?? null;
      let thinkingLevel = input.thinkingLevel ?? null;
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
      }
      const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
      const envKind = process.env.SANDBOX_PROVIDER ?? "docker";
      const kind =
        envKind === "docker" && settings?.computerHost === "this-mac" ? "desktop" : envKind;
      const bot = await prisma.$transaction(async (tx) => {
        const positions = await tx.bot.aggregate({
          where: { spaceId: actor.spaceId, userId: actor.userId },
          _max: { position: true },
        });
        const teamComputer = await ensureComputerRecord(tx, {
          mode: "team",
          spaceId: actor.spaceId,
          userId: actor.userId,
          kind,
        });
        const created = await tx.bot.create({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            name: input.name,
            title: input.title,
            description: input.description,
            instructions: input.instructions,
            notifyOnFinish: input.notifyOnFinish,
            color,
            position: (positions._max.position ?? -1) + 1,
            parentBotId: input.parentBotId ?? null,
            computerId: teamComputer.id,
            spawnKey: input.spawnKey,
            modelProvider,
            modelId,
            thinkingLevel,
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
            content: `# ${input.name}\n\n`,
          },
        });
        return tx.bot.findFirstOrThrow({
          where: { id: created.id },
          include: { thread: true, computer: true },
        });
      });
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
      const computer = await ensureComputerRecord(prisma, {
        mode,
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        kind: bot.computer.kind,
      });
      const updated = await prisma.bot.update({
        where: { id: botId },
        data: { computerId: computer.id },
        include: { thread: true, computer: true },
      });
      return mapBot(updated);
    },
  };
}
