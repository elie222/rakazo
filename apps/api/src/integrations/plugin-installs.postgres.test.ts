import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import {
  EncryptedSecretStore,
  previewPluginInstall,
  skillReadFromTool,
  withSecretPersistence,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { buildSkillMd } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentSkillsService } from "../bots/agent-skills.js";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";
import { installPlugin } from "./plugin-installs.js";

const actorScope = ({ userId, spaceId }: Actor) => ({ userId, spaceId });

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const sha = "a".repeat(40);
const fetcher = async () => ({
  resolvedSha: sha,
  files: [
    { path: ".grok-plugin/plugin.json", content: JSON.stringify({ name: "example-plugin" }) },
    {
      path: "skills/example/SKILL.md",
      content: "---\nname: plugin-test-skill\ndescription: Example\n---\n\nFollow these steps.\n",
    },
    {
      path: ".mcp.json",
      content: JSON.stringify({
        mcpServers: {
          example: {
            type: "http",
            url: "https://tools.example.test/mcp",
            headers: { "X-Tenant": "fake-package-tenant" },
          },
        },
      }),
    },
  ],
});

describe.skipIf(!enabled)("plugin install lifecycle (PostgreSQL, offline providers)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let actor: Actor;
  const suffix = randomUUID();
  const organizationId = `plugin-org-${suffix}`;
  const teammateId = `plugin-teammate-${suffix}`;
  const teammateSpaceId = `plugin-teammate-space-${suffix}`;
  const teammate: Actor = {
    userId: teammateId,
    spaceId: teammateSpaceId,
    email: `${teammateId}@example.test`,
    isDeploymentOwner: false,
  };
  const secrets = new EncryptedSecretStore("fake-plugin-test-encryption-key");
  const endpoint = vi.fn().mockResolvedValue(undefined);
  const deps = () => ({ prisma, secrets, fetcher, assertEndpoint: endpoint });
  const client = (asActor = actor) =>
    createRouterClient(
      createRouter({
        prisma,
        secrets,
        pluginRepoFetcher: fetcher,
        remoteConnectors: {
          resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
        },
        events: { notify: vi.fn() },
        env: {
          webOrigin: "http://localhost:5173",
          defaultProvider: "fake",
          defaultModel: "fake",
        },
        dataDir: "/tmp/plugin-db-test",
      } as unknown as RouterDeps),
      { context: { actor: asActor } },
    );
  const source = "https://github.com/example/plugin";
  const asActor = (fn: () => Promise<void>) => () => runAsTenant(actor, fn);
  async function input() {
    return {
      source,
      name: "Example",
      config: {},
      pluginDigest: (await previewPluginInstall({ source, fetcher })).digest,
    };
  }
  beforeAll(() =>
    runAsSystem("plugin install fixture", async () => {
      db = createDb(process.env.DATABASE_URL!);
      prisma = withSecretPersistence(db.prisma, secrets);
      const userId = `plugin-user-${suffix}`;
      const spaceId = `plugin-space-${suffix}`;
      await prisma.user.create({
        data: {
          id: userId,
          name: "Plugin Test",
          email: `${userId}@example.test`,
          emailVerified: false,
        },
      });
      await prisma.organization.create({
        data: {
          id: organizationId,
          name: "Plugin Test",
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
      await prisma.user.create({
        data: {
          id: teammateId,
          name: "Plugin Teammate",
          email: teammate.email,
          emailVerified: false,
        },
      });
      await prisma.member.createMany({
        data: [
          { id: `admin-${suffix}`, organizationId, userId, role: "admin", createdAt: new Date() },
          {
            id: `member-${suffix}`,
            organizationId,
            userId: teammateId,
            role: "member",
            createdAt: new Date(),
          },
        ],
      });
      await prisma.space.create({
        data: { id: teammateSpaceId, organizationId, name: "Teammate Space" },
      });
      await prisma.spaceMember.upsert({
        where: { spaceId_userId: { spaceId: teammateSpaceId, userId: teammateId } },
        create: {
          id: `teammate-space-member-${suffix}`,
          organizationId,
          spaceId: teammateSpaceId,
          userId: teammateId,
          createdAt: new Date(),
        },
        update: {},
      });
      actor = { spaceId, userId, email: `${userId}@example.test`, isDeploymentOwner: false };
    }),
  );
  afterAll(() =>
    runAsSystem("plugin install fixture", async () => {
      if (prisma) {
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.user.deleteMany({ where: { id: { in: [actor.userId, teammateId] } } });
        await prisma.$disconnect();
        await db.pool.end();
      }
      await secrets.close();
    }),
  );

  it(
    "makes a shared plugin additive and readable across Spaces without giving members management rights",
    asActor(async () => {
      const rpc = client();
      const request = { kind: "plugin" as const, ...(await input()) };
      const personal = await rpc.capabilities.install(request);
      const shared = await rpc.capabilities.install({ ...request, organization: true });
      try {
        await expect(
          rpc.capabilities.install({ ...request, organization: true }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        await runAsTenant(teammate, async () => {
          const member = client(teammate);
          expect((await member.capabilities.list()).filter((row) => row.source === source)).toEqual(
            [expect.objectContaining({ id: shared.id, organization: true, manageable: false })],
          );
          expect(await member.mcp.servers.list()).toContainEqual(
            expect.objectContaining({
              installId: shared.id,
              organization: true,
              allBots: true,
              manageable: false,
              hasSecret: true,
            }),
          );
          expect(
            await skillReadFromTool(prisma, teammate, { name: "plugin-test-skill" }),
          ).toMatchObject({
            content: expect.stringContaining("Follow these steps."),
          });
          await expect(
            member.capabilities.install({ ...request, organization: true }),
          ).rejects.toMatchObject({ code: "FORBIDDEN" });
          await expect(
            member.capabilities.pluginParts({ id: shared.id, parts: ["skills"] }),
          ).rejects.toMatchObject({ code: "NOT_FOUND" });
          await member.capabilities.remove({ id: shared.id });
          expect(await member.capabilities.list()).toContainEqual(
            expect.objectContaining({ id: shared.id }),
          );
        });
      } finally {
        await rpc.capabilities.remove({ id: shared.id });
        await rpc.capabilities.remove({ id: personal.id });
      }
    }),
  );

  it(
    "lets members read a shared standalone skill and reserves edits for admins",
    asActor(async () => {
      const rpc = client();
      const skill = await rpc.agentSkills.create({
        name: "shared-standalone",
        description: "Shared instructions",
        organization: true,
      });
      try {
        expect(skill).toMatchObject({ organization: true, readOnly: false });
        await runAsTenant(teammate, async () => {
          const member = client(teammate);
          expect(await member.agentSkills.get({ skillId: skill.id })).toMatchObject({
            organization: true,
            readOnly: true,
          });
          await expect(
            member.agentSkills.update({ skillId: skill.id, description: "Unauthorized" }),
          ).rejects.toMatchObject({ code: "FORBIDDEN" });
        });
        expect(
          await rpc.agentSkills.update({ skillId: skill.id, description: "Revised" }),
        ).toMatchObject({ description: "Revised" });
      } finally {
        await rpc.agentSkills.remove({ skillId: skill.id });
      }
    }),
  );

  it(
    "renames organization skill references according to each routine's visible skills",
    asActor(async () => {
      const rpc = client();
      const name = "Shared review";
      const destination = "Weekly review";
      const shared = await rpc.agentSkills.create({
        name,
        description: "Shared instructions",
        organization: true,
      });
      const fixtures = await runAsSystem("routine skill rename fixture", async () => {
        const ownerBot = await prisma.bot.create({
          data: { ...actorScope(actor), name: "Owner bot", color: "blue" },
        });
        const teammateBot = await prisma.bot.create({
          data: { ...actorScope(teammate), name: "Teammate bot", color: "blue" },
        });
        const ownerRoutine = await prisma.routine.create({
          data: {
            ...actorScope(actor),
            botId: ownerBot.id,
            name: "Owner routine",
            prompt: "Run @Shared review, then @Shared review tools.",
            crons: [],
          },
        });
        const teammateRoutine = await prisma.routine.create({
          data: {
            ...actorScope(teammate),
            botId: teammateBot.id,
            name: "Teammate routine",
            prompt: "Run @Shared review.",
            crons: [],
          },
        });
        const longer = await prisma.agentSkill.create({
          data: { ...actorScope(actor), name: "Shared review tools", description: "", content: "" },
        });
        const shadow = await prisma.agentSkill.create({
          data: { ...actorScope(teammate), name: name.toLowerCase(), description: "", content: "" },
        });
        const destinationShadow = await prisma.agentSkill.create({
          data: { ...actorScope(actor), name: destination, description: "", content: "" },
        });
        return {
          ownerBot,
          teammateBot,
          ownerRoutine,
          teammateRoutine,
          longer,
          shadow,
          destinationShadow,
        };
      });
      try {
        await expect(
          rpc.agentSkills.update({ skillId: shared.id, name: destination }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(await rpc.agentSkills.get({ skillId: shared.id })).toMatchObject({ name });
        await prisma.agentSkill.delete({ where: { id: fixtures.destinationShadow.id } });
        await rpc.agentSkills.update({ skillId: shared.id, name: destination });
        await runAsSystem("check routine skill references", async () => {
          expect(
            await prisma.routine.findUniqueOrThrow({ where: { id: fixtures.ownerRoutine.id } }),
          ).toMatchObject({ prompt: "Run @Weekly review, then @Shared review tools." });
          expect(
            await prisma.routine.findUniqueOrThrow({ where: { id: fixtures.teammateRoutine.id } }),
          ).toMatchObject({ prompt: "Run @Shared review." });
        });
        await runAsTenant(teammate, async () => {
          await client(teammate).agentSkills.update({
            skillId: fixtures.shadow.id,
            content: buildSkillMd({
              name: "Personal review",
              description: "Personal instructions",
              body: "",
            }),
          });
          expect(
            await prisma.routine.findUniqueOrThrow({ where: { id: fixtures.teammateRoutine.id } }),
          ).toMatchObject({ prompt: "Run @Personal review." });
          await prisma.routine.update({
            where: { id: fixtures.teammateRoutine.id },
            data: { prompt: "Run @Weekly review." },
          });
        });
        await rpc.agentSkills.update({ skillId: shared.id, name: "Monthly review" });
        await runAsTenant(teammate, async () => {
          expect(
            await prisma.routine.findUniqueOrThrow({ where: { id: fixtures.teammateRoutine.id } }),
          ).toMatchObject({ prompt: "Run @Monthly review." });
        });
      } finally {
        await rpc.agentSkills.remove({ skillId: shared.id });
        await runAsSystem("remove routine skill rename fixture", async () => {
          await prisma.bot.deleteMany({
            where: { id: { in: [fixtures.ownerBot.id, fixtures.teammateBot.id] } },
          });
          await prisma.agentSkill.deleteMany({
            where: {
              id: { in: [fixtures.longer.id, fixtures.shadow.id, fixtures.destinationShadow.id] },
            },
          });
        });
      }
    }),
  );

  it(
    "installs immutable read-only skills and encrypted native MCP rows, then fully uninstalls",
    asActor(async () => {
      const rpc = client();
      const preview = await rpc.capabilities.pluginPreview({ source });
      const install = await rpc.capabilities.install({
        kind: "plugin",
        source,
        name: "Example",
        config: {},
        pluginDigest: preview.digest,
      });
      const skill = await prisma.agentSkill.findFirstOrThrow({
        where: { installId: install.id },
      });
      const server = await prisma.mcpServer.findFirstOrThrow({
        where: { installId: install.id },
      });
      expect(install.version).toBe(sha);
      expect(skill.source).toBe("plugin");
      const service = createAgentSkillsService(prisma);
      expect((await service.get(actor, { skillId: skill.id })).readOnly).toBe(true);
      await expect(service.remove(actor, skill.id)).rejects.toThrow();
      expect(await prisma.botMcpServer.count({ where: { serverId: server.id } })).toBe(0);
      const secret = await prisma.secret.findUniqueOrThrow({ where: { id: server.secretId! } });
      expect(secret.ciphertext).not.toContain("fake-package-tenant");
      expect(JSON.parse(await secrets.load(secret.ciphertext, secret.id)).headers).toEqual({
        "X-Tenant": "fake-package-tenant",
      });
      expect(JSON.stringify(install.config)).not.toContain("fake-package-tenant");
      expect(server.headers).toEqual({ "X-Tenant": true });
      expect(await rpc.mcp.servers.list()).toContainEqual(
        expect.objectContaining({ id: server.id, oauthStatus: "none", hasSecret: true }),
      );

      // OAuth state and per-bot assignments must not survive uninstall either.
      await prisma.mcpOAuthSession.create({
        data: {
          id: randomUUID(),
          spaceId: actor.spaceId,
          userId: actor.userId,
          serverId: server.id,
          endpoint: server.endpoint!,
          redirectUri: "http://localhost:5173/mcp/oauth/callback",
          oauthCiphertext: "encrypted-pending-state",
        },
      });
      const bot = await prisma.bot.create({
        data: { spaceId: actor.spaceId, userId: actor.userId, name: "Test", color: "blue" },
      });
      await prisma.botMcpServer.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: bot.id,
          serverId: server.id,
        },
      });
      expect(await client().capabilities.remove({ id: install.id })).toEqual({ ok: true });
      expect(await prisma.capabilityInstall.findUnique({ where: { id: install.id } })).toBeNull();
      expect(await prisma.agentSkill.count({ where: { installId: install.id } })).toBe(0);
      expect(await prisma.mcpServer.count({ where: { installId: install.id } })).toBe(0);
      expect(await prisma.secret.findUnique({ where: { id: secret.id } })).toBeNull();
      expect(await prisma.mcpOAuthSession.count({ where: { serverId: server.id } })).toBe(0);
      expect(await prisma.botMcpServer.count({ where: { serverId: server.id } })).toBe(0);
    }),
  );

  it(
    "rolls back parent, skill and encrypted secret rows if a child write fails",
    asActor(async () => {
      const before = await prisma.secret.count({ where: { userId: actor.userId } });
      const fault = new Proxy(prisma, {
        get(target, key) {
          if (key === "$transaction")
            return (run: (tx: unknown) => Promise<unknown>) =>
              target.$transaction((tx) =>
                run(
                  new Proxy(tx, {
                    get(t, k) {
                      if (k === "mcpServer")
                        return {
                          create: async () => {
                            throw new Error("injected child failure");
                          },
                        };
                      return Reflect.get(t, k);
                    },
                  }),
                ),
              );
          return Reflect.get(target, key);
        },
      });
      await expect(
        installPlugin({ ...deps(), prisma: fault }, actor, await input()),
      ).rejects.toThrow("injected child failure");
      expect(
        await prisma.capabilityInstall.count({ where: { userId: actor.userId, kind: "plugin" } }),
      ).toBe(0);
      expect(
        await prisma.agentSkill.count({ where: { userId: actor.userId, source: "plugin" } }),
      ).toBe(0);
      expect(await prisma.secret.count({ where: { userId: actor.userId } })).toBe(before);
    }),
  );

  it(
    "serializes concurrent installs and does not let another actor remove them",
    asActor(async () => {
      const args = await input();
      const results = await Promise.allSettled([
        installPlugin(deps(), actor, args),
        installPlugin(deps(), actor, args),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const install = await prisma.capabilityInstall.findFirstOrThrow({
        where: { userId: actor.userId, kind: "plugin" },
      });
      await client({ ...actor, userId: "other-user" }).capabilities.remove({ id: install.id });
      expect(
        await prisma.capabilityInstall.findUnique({ where: { id: install.id } }),
      ).not.toBeNull();
      await client().capabilities.remove({ id: install.id });
    }),
  );

  it(
    "adds and removes a plugin's connector and skills as separate parts",
    asActor(async () => {
      const rpc = client();
      const preview = await rpc.capabilities.pluginPreview({ source });
      const install = await rpc.capabilities.install({
        kind: "plugin",
        source,
        name: "Example",
        config: {},
        pluginDigest: preview.digest,
        pluginParts: ["skills"],
      });
      expect(await prisma.mcpServer.count({ where: { installId: install.id } })).toBe(0);
      expect(await prisma.agentSkill.count({ where: { installId: install.id } })).toBe(1);

      const both = await rpc.capabilities.pluginParts({
        id: install.id,
        parts: ["skills", "connector"],
      });
      expect(both.install?.config).toMatchObject({ parts: ["skills", "connector"] });
      const server = await prisma.mcpServer.findFirstOrThrow({
        where: { installId: install.id },
      });
      expect(server.secretId).not.toBeNull();

      const connectorOnly = await rpc.capabilities.pluginParts({
        id: install.id,
        parts: ["connector"],
      });
      expect(connectorOnly.install?.config).toMatchObject({ parts: ["connector"] });
      expect(await prisma.agentSkill.count({ where: { installId: install.id } })).toBe(0);
      expect(await prisma.mcpServer.count({ where: { installId: install.id } })).toBe(1);

      expect(await rpc.capabilities.pluginParts({ id: install.id, parts: [] })).toEqual({
        install: null,
      });
      expect(await prisma.capabilityInstall.findUnique({ where: { id: install.id } })).toBeNull();
      expect(await prisma.mcpServer.count({ where: { installId: install.id } })).toBe(0);
      expect(await prisma.secret.findUnique({ where: { id: server.secretId! } })).toBeNull();
    }),
  );
});
