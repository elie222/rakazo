import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import { EncryptedSecretStore, withSecretPersistence } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requestMcpServerFromTool } from "../../../packages/adapters/src/mcp-server-access.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled).sequential("MCP server agents (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let actor: Actor;
  const suffix = randomUUID();
  const organizationId = `mcp-agents-org-${suffix}`;
  const secrets = new EncryptedSecretStore("fake-mcp-agents-test-encryption-key");
  const botIds = { chief: `mcp-agents-chief-${suffix}`, writer: `mcp-agents-writer-${suffix}` };
  const jobs = { enqueue: vi.fn(async () => undefined) };
  const client = () =>
    createRouterClient(
      createRouter({
        prisma,
        secrets,
        remoteConnectors: {
          resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
        },
        events: { notify: vi.fn() },
        jobs,
        env: { webOrigin: "http://localhost:5173", defaultProvider: "fake", defaultModel: "fake" },
        dataDir: "/tmp/mcp-agents-db-test",
      } as unknown as RouterDeps),
      { context: { actor } },
    );
  const asActor = (fn: () => Promise<void>) => () => runAsTenant(actor, fn);

  beforeAll(() =>
    runAsSystem("mcp agents fixture", async () => {
      db = createDb(process.env.DATABASE_URL!);
      prisma = withSecretPersistence(db.prisma, secrets);
      const userId = `mcp-agents-user-${suffix}`;
      const spaceId = `mcp-agents-space-${suffix}`;
      await prisma.user.create({
        data: { id: userId, name: "MCP Agents", email: `${userId}@example.test` },
      });
      await prisma.organization.create({
        data: {
          id: organizationId,
          name: "MCP Agents",
          slug: organizationId,
          createdAt: new Date(),
        },
      });
      await prisma.space.create({
        data: {
          id: spaceId,
          organizationId,
          name: "General",
          isDefault: true,
          createdByUserId: userId,
        },
      });
      for (const [name, id] of Object.entries(botIds))
        await prisma.bot.create({ data: { id, spaceId, userId, name, color: "blue" } });
      actor = { spaceId, userId, email: `${userId}@example.test`, isDeploymentOwner: false };
    }),
  );
  afterAll(() =>
    runAsSystem("mcp agents fixture", async () => {
      if (prisma) {
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.user.deleteMany({ where: { id: actor?.userId } });
        await prisma.$disconnect();
        await db.pool.end();
      }
      await secrets.close();
    }),
  );

  it(
    "shares a server the user adds with every agent, and narrows it to chosen agents",
    asActor(async () => {
      const created = await client().mcp.servers.create({
        transport: "streamable_http",
        slug: "search-console",
        name: "Search Console",
        endpoint: "https://mcp.search-console.test/mcp",
        headers: {},
        enabled: true,
      });
      expect(created.allBots).toBe(true);

      const narrowed = await client().mcp.servers.agents({
        id: created.id,
        allBots: false,
        botIds: [botIds.writer],
      });
      expect(narrowed.server.allBots).toBe(false);
      expect(narrowed.assignments.map((row) => row.botId)).toEqual([botIds.writer]);

      const switched = await client().mcp.servers.agents({
        id: created.id,
        allBots: false,
        botIds: [botIds.chief],
      });
      expect(switched.assignments.map((row) => row.botId)).toEqual([botIds.chief]);

      // Sharing again keeps the choice, so narrowing later starts from it.
      const shared = await client().mcp.servers.agents({ id: created.id, allBots: true });
      expect(shared.server.allBots).toBe(true);
      expect(shared.assignments.map((row) => row.botId)).toEqual([botIds.chief]);
    }),
  );

  it(
    "refuses agents and servers the user does not own",
    asActor(async () => {
      const [server] = await client().mcp.servers.list();
      await expect(
        client().mcp.servers.agents({ id: server!.id, allBots: false, botIds: ["other-bot"] }),
      ).rejects.toThrow();
      await expect(
        client().mcp.servers.agents({ id: "other-server", allBots: true }),
      ).rejects.toThrow();
      expect((await client().mcp.servers.list())[0]?.allBots).toBe(true);
    }),
  );
  it(
    "connects a server a bot asked for in chat and lets the bot carry on",
    asActor(async () => {
      const server = await client().mcp.servers.create({
        transport: "streamable_http",
        slug: "ticket-desk",
        name: "Ticket Desk",
        endpoint: "https://mcp.ticket-desk.test/mcp",
        headers: {},
        enabled: true,
      });
      await client().mcp.servers.agents({ id: server.id, allBots: false, botIds: [] });
      const scope = {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: botIds.writer,
        threadId: `mcp-agents-thread-${suffix}`,
      };
      await prisma.thread.create({
        data: {
          id: scope.threadId,
          spaceId: scope.spaceId,
          userId: scope.userId,
          botId: scope.botId,
        },
      });
      const task = await prisma.task.create({
        data: { ...scope, prompt: "Triage the open tickets", status: "running" },
      });
      const asking = await prisma.run.create({
        data: { ...scope, taskId: task.id, status: "running", trigger: "user" },
      });

      const requested = await requestMcpServerFromTool(
        { prisma, events: { notify: vi.fn(async () => undefined) }, secretStore: secrets } as never,
        { ...scope, id: asking.id },
        scope.botId,
        { slug: "ticket-desk" },
      );
      expect(requested).toMatchObject({ ok: true, server_id: server.id, status: "pending" });
      const [message] = await prisma.message.findMany({ where: { threadId: scope.threadId } });
      expect(message?.blocks).toEqual([
        {
          kind: "mcp_approval",
          name: "Ticket Desk",
          serverId: server.id,
          transport: "streamable_http",
          endpoint: "https://mcp.ticket-desk.test/mcp",
          needsOAuth: true,
          status: "pending",
        },
      ]);

      // The continuation waits for the asking turn to end.
      await prisma.run.update({ where: { id: asking.id }, data: { status: "completed" } });
      await client().mcp.assignments.approve({
        botId: scope.botId,
        serverId: server.id,
        threadId: scope.threadId,
      });

      expect(
        await prisma.botMcpServer.findFirst({
          where: { botId: scope.botId, serverId: server.id },
          select: { allowAllTools: true },
        }),
      ).toEqual({ allowAllTools: true });
      const continuation = await prisma.run.findFirst({
        where: { threadId: scope.threadId, status: "queued" },
        select: { id: true, trigger: true },
      });
      expect(continuation?.trigger).toBe("user");
      expect(jobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ name: "run.continue", payload: { runId: continuation?.id } }),
      );
      const [painted] = await prisma.message.findMany({ where: { threadId: scope.threadId } });
      expect(painted?.blocks).toMatchObject([{ status: "connected" }]);
    }),
  );
});
