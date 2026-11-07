import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import { EncryptedSecretStore, McpOAuthBroker, withSecretPersistence } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled).sequential("MCP catalog connect (PostgreSQL, offline providers)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let actor: Actor;
  let botId: string;
  let mcpOAuth: McpOAuthBroker;
  const suffix = randomUUID();
  const organizationId = `mcp-connect-org-${suffix}`;
  const secrets = new EncryptedSecretStore("fake-mcp-connect-test-encryption-key");
  const client = () =>
    createRouterClient(
      createRouter({
        prisma,
        secrets,
        mcpOAuth,
        remoteConnectors: {
          resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
        },
        events: { notify: vi.fn() },
        jobs: { enqueue: vi.fn(async () => undefined) },
        env: {
          webOrigin: "http://localhost:5173",
          defaultProvider: "fake",
          defaultModel: "fake",
        },
        dataDir: "/tmp/mcp-connect-db-test",
      } as unknown as RouterDeps),
      { context: { actor } },
    );
  const asActor = (fn: () => Promise<void>) => () => runAsTenant(actor, fn);
  const servers = () =>
    prisma.mcpServer.findMany({ where: { userId: actor.userId }, orderBy: { createdAt: "asc" } });
  const assignments = () => prisma.botMcpServer.findMany({ where: { botId } });

  beforeAll(() =>
    runAsSystem("mcp connect fixture", async () => {
      db = createDb(process.env.DATABASE_URL!);
      prisma = withSecretPersistence(db.prisma, secrets);
      mcpOAuth = new McpOAuthBroker(prisma, secrets);
      const userId = `mcp-connect-user-${suffix}`;
      const spaceId = `mcp-connect-space-${suffix}`;
      await prisma.user.create({
        data: {
          id: userId,
          name: "Connect Test",
          email: `${userId}@example.test`,
          emailVerified: false,
        },
      });
      await prisma.organization.create({
        data: {
          id: organizationId,
          name: "Connect Test",
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
      botId = (
        await prisma.bot.create({ data: { spaceId, userId, name: "Researcher", color: "blue" } })
      ).id;
      actor = { spaceId, userId, email: `${userId}@example.test`, isDeploymentOwner: false };
    }),
  );
  beforeEach(() =>
    runAsSystem("mcp connect fixture", async () => {
      vi.restoreAllMocks();
      await prisma.mcpServer.deleteMany({ where: { userId: actor.userId } });
    }),
  );
  afterAll(() =>
    runAsSystem("mcp connect fixture", async () => {
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
    "adds one server when two sign-ins to the same new address start together",
    asActor(async () => {
      vi.spyOn(mcpOAuth, "begin").mockResolvedValue({ status: "authorization_not_requested" });
      const rpc = client();

      const [first, second] = await Promise.all([
        rpc.mcp.servers.connect({ name: "Tracker", endpoint: "https://mcp.tracker.example.test/" }),
        rpc.mcp.servers.connect({ name: "Tracker", endpoint: "https://mcp.tracker.example.test" }),
      ]);

      expect(second.server.id).toBe(first.server.id);
      expect(await servers()).toHaveLength(1);
    }),
  );

  it(
    "adds a new server rather than reuse a disabled one",
    asActor(async () => {
      vi.spyOn(mcpOAuth, "begin").mockResolvedValue({ status: "authorization_not_requested" });
      const rpc = client();
      const endpoint = "https://mcp.tracker.example.test/mcp";
      const { server } = await rpc.mcp.servers.connect({ name: "Tracker", endpoint });
      await prisma.mcpServer.update({ where: { id: server.id }, data: { enabled: false } });

      const again = await rpc.mcp.servers.connect({ name: "Tracker again", endpoint });

      expect(again.server.id).not.toBe(server.id);
    }),
  );

  it(
    "gives the bot a server that needs no sign-in right away",
    asActor(async () => {
      vi.spyOn(mcpOAuth, "begin").mockResolvedValue({ status: "authorization_not_requested" });

      const { server } = await client().mcp.servers.connect({
        name: "Open tools",
        endpoint: "https://mcp.open.example.test/mcp",
        botId,
      });

      expect(await assignments()).toMatchObject([{ serverId: server.id }]);
    }),
  );

  it(
    "gives the bot the server only once its sign-in finishes",
    asActor(async () => {
      const begin = vi.spyOn(mcpOAuth, "begin").mockResolvedValue({
        status: "authorization_required",
        sessionId: "session-1",
        authorizationUrl: "https://auth.tracker.example.test/authorize",
      });
      const rpc = client();

      const { server } = await rpc.mcp.servers.connect({
        name: "Tracker",
        endpoint: "https://mcp.tracker.example.test/mcp",
        botId,
      });
      expect(begin).toHaveBeenCalledWith(expect.objectContaining({ serverId: server.id, botId }));
      expect(await assignments()).toEqual([]);

      vi.spyOn(mcpOAuth, "complete").mockResolvedValue({ serverId: server.id, revision: 1, botId });
      await expect(
        rpc.mcp.oauth.complete({ sessionId: "session-1", state: "session-1", code: "fake-code" }),
      ).resolves.toEqual({ ok: true, status: "connected" });

      expect(await assignments()).toMatchObject([{ serverId: server.id }]);
    }),
  );

  it(
    "reads a refusal at the provider as a cancelled sign-in",
    asActor(async () => {
      const complete = vi.spyOn(mcpOAuth, "complete");

      await expect(
        client().mcp.oauth.complete({
          sessionId: "session-1",
          state: "session-1",
          error: "access_denied",
        }),
      ).resolves.toEqual({ ok: true, status: "cancelled" });
      expect(complete).not.toHaveBeenCalled();
    }),
  );

  it(
    "reports the provider's error, and refuses an answer for another sign-in",
    asActor(async () => {
      const rpc = client();

      await expect(
        rpc.mcp.oauth.complete({
          sessionId: "session-1",
          state: "session-1",
          error: "server_error",
          errorDescription: "The provider is down",
        }),
      ).rejects.toMatchObject({ message: "The provider is down" });
      await expect(
        rpc.mcp.oauth.complete({ sessionId: "session-1", state: "session-2", code: "fake-code" }),
      ).rejects.toMatchObject({ message: "MCP OAuth session is invalid or expired" });
    }),
  );
});
