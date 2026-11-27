import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  createDb,
  createThreadMessageInTransaction,
  runAsSystem,
  runAsTenant,
  storedMessageBlocks,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("approving an organization MCP server's card (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const suffix = randomUUID();
  const organizationId = `mcp-approval-org-${suffix}`;
  const spaceId = `mcp-approval-space-${suffix}`;
  const askerId = `mcp-approval-asker-${suffix}`;
  const otherId = `mcp-approval-other-${suffix}`;
  const member = (userId: string): Actor => ({
    spaceId,
    userId,
    email: `${userId}@example.test`,
    isDeploymentOwner: false,
  });
  const client = (actor: Actor, jobs: { enqueue: () => Promise<void> }) =>
    createRouterClient(
      createRouter({
        prisma,
        events: { notify: vi.fn() },
        jobs,
        env: { webOrigin: "http://localhost:5173", defaultProvider: "fake", defaultModel: "fake" },
        dataDir: "/tmp/mcp-approval-db-test",
      } as unknown as RouterDeps),
      { context: { actor } },
    );

  beforeAll(() =>
    runAsSystem("mcp approval fixture", async () => {
      db = createDb(process.env.DATABASE_URL!);
      prisma = db.prisma;
      await prisma.organization.create({
        data: { id: organizationId, name: "Team", slug: organizationId, createdAt: new Date() },
      });
      for (const [id, role] of [
        [askerId, "owner"],
        [otherId, "member"],
      ] as const) {
        await prisma.user.create({
          data: { id, name: role, email: `${id}@example.test`, emailVerified: true },
        });
        await prisma.member.create({
          data: { id, organizationId, userId: id, role, createdAt: new Date() },
        });
      }
      await prisma.space.create({
        data: {
          id: spaceId,
          organizationId,
          name: "General",
          isDefault: true,
          createdByUserId: askerId,
        },
      });
    }),
  );
  afterAll(() =>
    runAsSystem("mcp approval fixture", async () => {
      if (!prisma) return;
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.user.deleteMany({ where: { id: { in: [askerId, otherId] } } });
      await prisma.$disconnect();
      await db.pool.end();
    }),
  );

  /** A group chat where the asker's run lost the organization's server to an expired sign-in. */
  function reconnectCard() {
    return runAsSystem("mcp approval fixture", async () => {
      const bot = await prisma.bot.create({
        data: { spaceId, userId: askerId, name: "Helper", color: "ink" },
      });
      const server = await prisma.mcpServer.create({
        data: {
          organizationId,
          slug: `tracker-${bot.id}`,
          name: "Tracker",
          transport: "streamable_http",
          endpoint: "https://mcp.tracker.example.test/mcp",
        },
      });
      await prisma.botMcpServer.create({
        data: { spaceId, userId: askerId, botId: bot.id, serverId: server.id },
      });
      const group = await prisma.chatGroup.create({
        data: {
          spaceId,
          userId: askerId,
          name: "Planning",
          members: { create: { botId: bot.id } },
          thread: { create: { spaceId, userId: askerId } },
        },
        include: { thread: true },
      });
      const chat = { botId: bot.id, serverId: server.id, threadId: group.thread!.id };
      const card = await cardFrom(chat, askerId, "pending");
      return { ...chat, cardRunId: card.runId, cardId: card.id };
    });
  }

  /** A card posted by a run `userId` started in the chat. */
  function cardFrom(
    chat: { botId: string; serverId: string; threadId: string },
    userId: string,
    status: "pending" | "dismissed",
  ) {
    return runAsSystem("mcp approval fixture", async () => {
      const { botId, serverId, threadId } = chat;
      const task = await prisma.task.create({
        data: { spaceId, botId, threadId, userId, prompt: "File the bug", status: "completed" },
      });
      const run = await prisma.run.create({
        data: {
          spaceId,
          botId,
          threadId,
          taskId: task.id,
          userId,
          status: "completed",
          trigger: "user",
        },
      });
      const block: MessageBlock = {
        kind: "mcp_approval",
        name: "Tracker",
        serverId,
        transport: "streamable_http",
        endpoint: "https://mcp.tracker.example.test/mcp",
        needsOAuth: true,
        status,
      };
      const card = await prisma.$transaction((tx) =>
        createThreadMessageInTransaction(tx, {
          threadId,
          botId,
          runId: run.id,
          role: "bot",
          blocks: [block],
        }),
      );
      return { id: card.id, runId: run.id };
    });
  }

  const statuses = (ids: string[]) =>
    runAsSystem("mcp approval fixture", async () => {
      const cards = await prisma.message.findMany({
        where: { id: { in: ids } },
        select: { id: true, blocks: true },
      });
      return ids.map((id) => {
        const [block] = storedMessageBlocks(cards.find((card) => card.id === id)!);
        return block?.kind === "mcp_approval" ? block.status : undefined;
      });
    });

  it("refuses another member's card, leaving it open with no run started", async () => {
    const { botId, serverId, threadId, cardRunId, cardId } = await reconnectCard();
    const other = member(otherId);
    const jobs = { enqueue: vi.fn(async () => undefined) };

    await expect(
      runAsTenant(other, () =>
        client(other, jobs).mcp.assignments.approve({ botId, serverId, threadId }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const { runs, card } = await runAsSystem("mcp approval fixture", async () => ({
      runs: await prisma.run.findMany({ where: { threadId, id: { not: cardRunId } } }),
      card: await prisma.message.findUniqueOrThrow({
        where: { id: cardId },
        select: { id: true, blocks: true },
      }),
    }));
    expect(runs).toEqual([]);
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(storedMessageBlocks(card)).toMatchObject([{ kind: "mcp_approval", status: "pending" }]);
  });

  it("refuses the other member's card when a member taps it beside their own open one", async () => {
    const chat = await reconnectCard();
    const own = await cardFrom(chat, otherId, "pending");
    const other = member(otherId);
    const jobs = { enqueue: vi.fn(async () => undefined) };

    await expect(
      runAsTenant(other, () =>
        client(other, jobs).mcp.assignments.approve({
          botId: chat.botId,
          serverId: chat.serverId,
          threadId: chat.threadId,
          messageId: chat.cardId,
        }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const runs = await runAsSystem("mcp approval fixture", () =>
      prisma.run.findMany({
        where: { threadId: chat.threadId, id: { notIn: [chat.cardRunId, own.runId] } },
      }),
    );
    expect(runs).toEqual([]);
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(await statuses([chat.cardId, own.id])).toEqual(["pending", "pending"]);
  });

  it("connects every member's card when the server is approved from Settings", async () => {
    const chat = await reconnectCard();
    const theirs = await cardFrom(chat, otherId, "pending");
    const asker = member(askerId);

    await runAsTenant(asker, () =>
      client(asker, { enqueue: vi.fn(async () => undefined) }).mcp.assignments.approve({
        botId: chat.botId,
        serverId: chat.serverId,
      }),
    );

    expect(await statuses([chat.cardId, theirs.id])).toEqual(["connected", "connected"]);
  });

  it.each([
    ["names the card", true],
    ["comes from an older client", false],
  ])(
    "repeats Not now on the member's own answered card beside another's open one when it %s",
    async (_, named) => {
      const chat = await reconnectCard();
      const own = await cardFrom(chat, otherId, "dismissed");
      const other = member(otherId);

      await expect(
        runAsTenant(other, () =>
          client(other, { enqueue: vi.fn(async () => undefined) }).mcp.assignments.dismiss({
            botId: chat.botId,
            serverId: chat.serverId,
            threadId: chat.threadId,
            ...(named ? { messageId: own.id } : {}),
          }),
        ),
      ).resolves.toEqual({ ok: true });
      expect(await statuses([chat.cardId, own.id])).toEqual(["pending", "dismissed"]);
    },
  );
});
