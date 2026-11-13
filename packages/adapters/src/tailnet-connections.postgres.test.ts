import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { createDb, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSecretPersistence } from "./secret-persistence.js";
import { EncryptedSecretStore } from "./secrets.js";
import {
  getTailnetConnection,
  removeTailnetConnection,
  resolveRunTailnet,
  saveTailnetConnection,
  setTailnetBotAccess,
} from "./tailnet-connections.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("tailnet connections (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const suffix = randomUUID();
  const organizationId = `tailnet-org-${suffix}`;
  const scope = { userId: `tailnet-user-${suffix}`, spaceId: `tailnet-space-${suffix}` };
  const botId = `tailnet-bot-${suffix}`;
  const secretStore = new EncryptedSecretStore("fake-tailnet-test-encryption-key");
  const client = (secret: string) => ({
    clientId: "client-a",
    clientSecret: secret,
    tag: "tag:rakazo",
  });

  beforeAll(() =>
    runAsSystem("tailnet fixture", async () => {
      db = createDb(process.env.DATABASE_URL!);
      // Through secret persistence, as the API and worker write it.
      prisma = withSecretPersistence(db.prisma, secretStore);
      await prisma.user.create({
        data: { id: scope.userId, name: "Tailnet", email: `${scope.userId}@example.test` },
      });
      await prisma.organization.create({
        data: { id: organizationId, name: "Tailnet", slug: organizationId, createdAt: new Date() },
      });
      await prisma.member.create({
        data: {
          id: `tailnet-member-${suffix}`,
          organizationId,
          userId: scope.userId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      await prisma.space.create({
        data: {
          id: scope.spaceId,
          organizationId,
          name: "General",
          isDefault: true,
          createdByUserId: scope.userId,
        },
      });
      await prisma.spaceMember.create({
        data: {
          id: `tailnet-space-member-${suffix}`,
          spaceId: scope.spaceId,
          organizationId,
          userId: scope.userId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      await prisma.bot.create({
        data: {
          id: botId,
          spaceId: scope.spaceId,
          userId: scope.userId,
          name: "Helper",
          color: "blue",
        },
      });
    }),
  );

  afterAll(() =>
    runAsSystem("tailnet fixture", async () => {
      if (prisma) {
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.user.deleteMany({ where: { id: scope.userId } });
      }
      await db?.prisma.$disconnect();
      await db?.pool.end();
    }),
  );

  it("saves, replaces, lets a bot on and removes a member's connection", () =>
    runAsSystem("tailnet connection", async () => {
      const verify = async () => undefined;
      await saveTailnetConnection({ prisma, secretStore, scope, config: client("first"), verify });
      await saveTailnetConnection({ prisma, secretStore, scope, config: client("second"), verify });
      expect(await getTailnetConnection(prisma, scope)).toEqual({ tag: "tag:rakazo", botIds: [] });

      await setTailnetBotAccess({ prisma, scope, botId, enabled: true });
      const run = { ...scope, botId };
      expect(await resolveRunTailnet({ prisma, secretStore, run })).toEqual(client("second"));

      await setTailnetBotAccess({ prisma, scope, botId, enabled: false });
      expect(await resolveRunTailnet({ prisma, secretStore, run })).toBeUndefined();
      expect(await removeTailnetConnection({ prisma, scope })).toBe(true);
      expect(await getTailnetConnection(prisma, scope)).toBeNull();
    }));
});
