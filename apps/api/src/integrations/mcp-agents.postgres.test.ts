import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import { EncryptedSecretStore, withSecretPersistence } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("MCP server agents (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let actor: Actor;
  const suffix = randomUUID();
  const organizationId = `mcp-agents-org-${suffix}`;
  const secrets = new EncryptedSecretStore("fake-mcp-agents-test-encryption-key");
  const botIds = { chief: `mcp-agents-chief-${suffix}`, writer: `mcp-agents-writer-${suffix}` };
  const teammateId = `mcp-agents-teammate-${suffix}`;
  const teammateBotId = `mcp-agents-teammate-bot-${suffix}`;
  const otherSpaceBotId = `mcp-agents-other-space-bot-${suffix}`;
  const client = () =>
    createRouterClient(
      createRouter({
        prisma,
        secrets,
        remoteConnectors: {
          resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
        },
        events: { notify: vi.fn() },
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
      await prisma.user.create({
        data: { id: teammateId, name: "Teammate", email: `${teammateId}@example.test` },
      });
      await prisma.bot.create({
        data: { id: teammateBotId, spaceId, userId: teammateId, name: "shared", color: "green" },
      });
      const otherSpaceId = `mcp-agents-other-space-${suffix}`;
      await prisma.space.create({
        data: { id: otherSpaceId, organizationId, name: "Other", createdByUserId: userId },
      });
      await prisma.bot.create({
        data: {
          id: otherSpaceBotId,
          spaceId: otherSpaceId,
          userId,
          name: "elsewhere",
          color: "red",
        },
      });
      actor = { spaceId, userId, email: `${userId}@example.test`, isDeploymentOwner: false };
    }),
  );
  afterAll(() =>
    runAsSystem("mcp agents fixture", async () => {
      if (prisma) {
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.user.deleteMany({ where: { id: { in: [actor?.userId, teammateId] } } });
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
    "refuses bots outside the Space and servers the user does not own",
    asActor(async () => {
      const [server] = await client().mcp.servers.list();
      for (const botId of ["other-bot", otherSpaceBotId])
        await expect(
          client().mcp.servers.agents({ id: server!.id, allBots: false, botIds: [botId] }),
        ).rejects.toThrow();
      await expect(
        client().mcp.servers.agents({ id: "other-server", allBots: true }),
      ).rejects.toThrow();
      expect((await client().mcp.servers.list())[0]?.allBots).toBe(true);
    }),
  );

  it(
    "lets a teammate's bot in the Space use the server",
    asActor(async () => {
      const [server] = await client().mcp.servers.list();
      const chosen = await client().mcp.servers.agents({
        id: server!.id,
        allBots: false,
        botIds: [teammateBotId],
      });
      expect(chosen.assignments.map((row) => row.botId)).toEqual([teammateBotId]);
    }),
  );

  it(
    "keeps an archived bot's access when the chosen bots change",
    asActor(async () => {
      const [server] = await client().mcp.servers.list();
      await client().mcp.servers.agents({
        id: server!.id,
        allBots: false,
        botIds: [botIds.chief, botIds.writer],
      });
      await runAsSystem("mcp agents fixture", () =>
        prisma.bot.update({ where: { id: botIds.writer }, data: { archivedAt: new Date() } }),
      );
      // Clients list only active bots, so they send the choice without the archived one.
      const changed = await client().mcp.servers.agents({
        id: server!.id,
        allBots: false,
        botIds: [],
      });
      expect(changed.assignments).toEqual([]);
      const kept = await prisma.botMcpServer.findMany({
        where: { serverId: server!.id },
        select: { botId: true },
      });
      expect(kept.map((row) => row.botId)).toEqual([botIds.writer]);

      // A choice loaded before the bot was archived keeps its row but adds none.
      const stale = () =>
        client().mcp.servers.agents({ id: server!.id, allBots: false, botIds: [botIds.writer] });
      expect((await stale()).assignments).toEqual([]);
      expect(await prisma.botMcpServer.count({ where: { serverId: server!.id } })).toBe(1);
      await runAsSystem("mcp agents fixture", () =>
        prisma.botMcpServer.deleteMany({ where: { serverId: server!.id } }),
      );
      expect((await stale()).assignments).toEqual([]);
      expect(await prisma.botMcpServer.count({ where: { serverId: server!.id } })).toBe(0);
    }),
  );

  it(
    "adds a server for chosen agents only, in the same save",
    asActor(async () => {
      const created = await client().mcp.servers.createForBots({
        config: {
          transport: "streamable_http",
          slug: "tickets",
          name: "Tickets",
          endpoint: "https://mcp.tickets.test/mcp",
          headers: {},
          enabled: true,
        },
        botIds: [botIds.chief],
      });
      expect(created.allBots).toBe(false);
      const rows = await prisma.botMcpServer.findMany({ where: { serverId: created.id } });
      expect(rows.map((row) => row.botId)).toEqual([botIds.chief]);
    }),
  );

  it(
    "keeps a server's settings when the access saved with them is refused",
    asActor(async () => {
      const config = {
        transport: "streamable_http" as const,
        slug: "wiki",
        name: "Wiki",
        endpoint: "https://mcp.wiki.test/mcp",
        headers: {},
        enabled: true,
      };
      const server = await client().mcp.servers.create(config);
      await expect(
        client().mcp.servers.save({
          id: server.id,
          config: { ...config, name: "Renamed" },
          access: { allBots: false, botIds: [otherSpaceBotId] },
        }),
      ).rejects.toThrow();
      const kept = (await client().mcp.servers.list()).find((row) => row.id === server.id);
      expect(kept).toMatchObject({ name: "Wiki", allBots: true });
    }),
  );

  it(
    "saves a server's settings and chosen agents in one call",
    asActor(async () => {
      const config = {
        transport: "streamable_http" as const,
        slug: "notes",
        name: "Notes",
        endpoint: "https://mcp.notes.test/mcp",
        headers: {},
        enabled: true,
      };
      const server = await client().mcp.servers.create(config);
      const saved = await client().mcp.servers.save({
        id: server.id,
        config: { ...config, name: "Renamed" },
        access: { allBots: false, botIds: [botIds.chief] },
      });
      expect(saved).toMatchObject({ name: "Renamed", allBots: false });
      const rows = await prisma.botMcpServer.findMany({ where: { serverId: server.id } });
      expect(rows.map((row) => row.botId)).toEqual([botIds.chief]);
    }),
  );
});
