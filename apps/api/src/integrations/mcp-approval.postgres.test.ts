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
      const threadId = group.thread!.id;
      const task = await prisma.task.create({
        data: {
          spaceId,
          botId: bot.id,
          threadId,
          userId: askerId,
          prompt: "File the bug",
          status: "completed",
        },
      });
      const run = await prisma.run.create({
        data: {
          spaceId,
          botId: bot.id,
          threadId,
          taskId: task.id,
          userId: askerId,
          status: "completed",
          trigger: "user",
        },
      });
      const block: MessageBlock = {
        kind: "mcp_approval",
        name: server.name,
        serverId: server.id,
        transport: "streamable_http",
        endpoint: server.endpoint,
        needsOAuth: true,
        status: "pending",
      };
      const card = await prisma.$transaction((tx) =>
        createThreadMessageInTransaction(tx, {
          threadId,
          botId: bot.id,
          runId: run.id,
          role: "bot",
          blocks: [block],
        }),
      );
      return { botId: bot.id, serverId: server.id, threadId, cardRunId: run.id, cardId: card.id };
    });
  }

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

  it("refuses Not now on another member's open card beside the member's own answered one", async () => {
    const { botId, serverId, threadId, cardId } = await reconnectCard();
    const other = member(otherId);
    await runAsSystem("mcp approval fixture", async () => {
      const card = await prisma.message.findUniqueOrThrow({
        where: { id: cardId },
        select: { id: true, blocks: true },
      });
      const blocks = storedMessageBlocks(card).map((block) => ({ ...block, status: "connected" }));
      await prisma.$transaction((tx) =>
        createThreadMessageInTransaction(tx, {
          threadId,
          botId,
          role: "bot",
          blocks: blocks as MessageBlock[],
        }),
      );
    });

    await expect(
      runAsTenant(other, () =>
        client(other, { enqueue: vi.fn(async () => undefined) }).mcp.assignments.dismiss({
          botId,
          serverId,
          threadId,
        }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
