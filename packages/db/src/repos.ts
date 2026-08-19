import { type Actor, BOT_COLORS, type Bot, type MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { type ComputerMode, ensureComputerRecord, parseComputerMode } from "./computers.js";
import { createThreadMessageInTransaction } from "./messages.js";
import { IsolationError } from "./scope.js";

function mapBot(
  bot: {
    id: string;
    workspaceId: string;
    name: string;
    title: string;
    description: string;
    instructions: string;
    color: string;
    notifyOnFinish: boolean;
    pinned: boolean;
    archivedAt: Date | null;
    parentBotId: string | null;
    createdAt: Date;
    updatedAt: Date;
    thread: { id: string; unread: boolean } | null;
    computer: { scope: string } | null;
  },
  preview = "",
  status = "idle",
): Bot {
  if (!bot.thread) {
    throw new IsolationError("Bot is missing its thread");
  }
  return {
    id: bot.id,
    workspaceId: bot.workspaceId,
    name: bot.name,
    title: bot.title,
    description: bot.description,
    instructions: bot.instructions,
    color: bot.color,
    notifyOnFinish: bot.notifyOnFinish,
    pinned: bot.pinned,
    archivedAt: bot.archivedAt?.toISOString() ?? null,
    unread: bot.thread.unread,
    parentBotId: bot.parentBotId,
    threadId: bot.thread.id,
    preview,
    status,
    computerMode: bot.computer ? parseComputerMode(bot.computer.scope) : "team",
    createdAt: bot.createdAt.toISOString(),
    updatedAt: bot.updatedAt.toISOString(),
  };
}

export function createRepos(prisma: PrismaClient) {
  return {
    async listBots(actor: Actor, options: { archived?: boolean } = {}): Promise<Bot[]> {
      const bots = await prisma.bot.findMany({
        where: {
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          archivedAt: options.archived ? { not: null } : null,
        },
        include: {
          thread: {
            include: {
              messages: { orderBy: { seq: "desc" }, take: 1 },
            },
          },
          runs: {
            where: {
              status: { in: ["running", "queued", "leased", "waiting_input", "waiting_takeover"] },
            },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
          computer: { select: { scope: true } },
        },
        orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
      });
      return bots.map((bot) => {
        const blocks = (bot.thread?.messages[0]?.blocks ?? []) as Array<{
          kind?: string;
          text?: string;
        }>;
        const preview = blocks.find((block) => block.text)?.text ?? "";
        return mapBot(bot, preview, bot.runs[0]?.status ?? "idle");
      });
    },

    async getBot(actor: Actor, botId: string, options: { includeArchived?: boolean } = {}) {
      const bot = await prisma.bot.findFirst({
        where: {
          id: botId,
          workspaceId: actor.workspaceId,
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
          where: { workspaceId: actor.workspaceId, userId: actor.userId },
        });
        color = BOT_COLORS[count % BOT_COLORS.length] ?? BOT_COLORS[0];
      }
      if (input.parentBotId) {
        const parent = await prisma.bot.findFirst({
          where: {
            id: input.parentBotId,
            workspaceId: actor.workspaceId,
            userId: actor.userId,
          },
        });
        if (!parent) throw new IsolationError();
      }
      const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
      const envKind = process.env.SANDBOX_PROVIDER ?? "docker";
      const kind =
        envKind === "docker" && settings?.computerHost === "this-mac" ? "desktop" : envKind;
      const bot = await prisma.$transaction(async (tx) => {
        const teamComputer = await ensureComputerRecord(tx, {
          mode: "team",
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          kind,
        });
        const created = await tx.bot.create({
          data: {
            workspaceId: actor.workspaceId,
            userId: actor.userId,
            name: input.name,
            title: input.title,
            description: input.description,
            instructions: input.instructions,
            notifyOnFinish: input.notifyOnFinish,
            color,
            parentBotId: input.parentBotId ?? null,
            computerId: teamComputer.id,
            spawnKey: input.spawnKey,
          },
        });
        const thread = await tx.thread.create({
          data: {
            workspaceId: actor.workspaceId,
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
            workspaceId: actor.workspaceId,
            userId: actor.userId,
            botId: created.id,
            kind,
          });
          await tx.bot.update({ where: { id: created.id }, data: { computerId: dedicated.id } });
        }
        await tx.browserProfile.create({
          data: {
            workspaceId: actor.workspaceId,
            botId: created.id,
            userId: actor.userId,
          },
        });
        await tx.memoryDocument.create({
          data: {
            workspaceId: actor.workspaceId,
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

    async setBotComputer(actor: Actor, botId: string, mode: ComputerMode): Promise<Bot> {
      const bot = await prisma.bot.findFirst({
        where: { id: botId, workspaceId: actor.workspaceId, userId: actor.userId },
        include: { computer: true },
      });
      if (!bot?.computer) throw new IsolationError();
      const computer = await ensureComputerRecord(prisma, {
        mode,
        workspaceId: actor.workspaceId,
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
