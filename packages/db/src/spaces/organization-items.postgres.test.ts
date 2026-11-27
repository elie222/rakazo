import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../database/client.js";
import { createDb } from "../database/client.js";
import { runAsSystem, runAsTenant } from "../database/row-security.js";
import { assertNameFreeWhereAvailable } from "./name-claims.js";
import {
  managedOrganizationId,
  organizationModelConnectionIn,
  organizationServerAt,
  personalOrOrganizationItemIn,
  serverSecretIn,
} from "./organization-items.js";

// The runtime login, so row-level security applies exactly as it does in a deployment.
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("an organization's MCP servers (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `orgmcp-org-${suffix}`;
  const otherOrganizationId = `orgmcp-other-${suffix}`;
  const admin = `orgmcp-admin-${suffix}`;
  const member = `orgmcp-member-${suffix}`;
  const guest = `orgmcp-guest-${suffix}`;
  const outsider = `orgmcp-outsider-${suffix}`;
  const team = `orgmcp-team-${suffix}`;
  const memberOwn = `orgmcp-mine-${suffix}`;
  const outsiderSpace = `orgmcp-outside-${suffix}`;
  const serverId = `orgmcp-server-${suffix}`;
  const secretId = `orgmcp-secret-${suffix}`;

  const reachable = (spaceId: string, userId: string) =>
    runAsTenant({ spaceId, userId }, async () => ({
      // What the database itself lets this tenant read, with no app filter.
      rows: (await prisma.mcpServer.findMany({ where: { id: serverId } })).length,
      secrets: (await prisma.secret.findMany({ where: { id: secretId } })).length,
      servers: (
        await prisma.mcpServer.findMany({
          where: { id: serverId, ...personalOrOrganizationItemIn({ spaceId, userId }) },
        })
      ).length,
      serverSecrets: (
        await prisma.secret.findMany({
          where: { id: secretId, ...serverSecretIn({ spaceId, userId }) },
        })
      ).length,
    }));

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    await runAsSystem("organization MCP fixture", async () => {
      for (const [id, defaultSpace] of [
        [organizationId, team],
        [otherOrganizationId, outsiderSpace],
      ] as const) {
        await prisma.organization.create({
          data: { id, name: id, slug: id, createdAt: new Date() },
        });
        await prisma.space.create({
          data: { id: defaultSpace, organizationId: id, name: "Team", isDefault: true },
        });
      }
      await prisma.space.create({
        data: { id: memberOwn, organizationId, name: "Personal" },
      });
      for (const [userId, orgId, role] of [
        [admin, organizationId, "admin"],
        [member, organizationId, "member"],
        [guest, organizationId, "guest"],
        [outsider, otherOrganizationId, "owner"],
      ] as const) {
        await prisma.user.create({
          data: { id: userId, name: userId, email: `${userId}@rakazo.test`, emailVerified: false },
        });
        await prisma.member.create({
          data: { id: `${userId}-m`, organizationId: orgId, userId, role, createdAt: new Date() },
        });
      }
      await prisma.member.create({
        data: {
          id: `${member}-other`,
          organizationId: otherOrganizationId,
          userId: member,
          role: "member",
          createdAt: new Date(),
        },
      });
      for (const [userId, spaceId] of [
        [member, memberOwn],
        [guest, team],
      ] as const)
        await prisma.spaceMember.upsert({
          where: { spaceId_userId: { spaceId, userId } },
          create: {
            id: `${userId}-${spaceId}`,
            organizationId,
            spaceId,
            userId,
            createdAt: new Date(),
          },
          update: {},
        });
      await prisma.secret.create({
        data: { id: secretId, organizationId, kind: "mcp", ciphertext: "sealed" },
      });
      await prisma.mcpServer.create({
        data: {
          id: serverId,
          organizationId,
          slug: "tracker",
          name: "Tracker",
          transport: "streamable_http",
          endpoint: "https://tracker.example.test/mcp",
          secretId,
          allBots: true,
        },
      });
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await runAsSystem("organization MCP fixture", async () => {
      await prisma.organization.deleteMany({
        where: { id: { in: [organizationId, otherOrganizationId] } },
      });
      await prisma.user.deleteMany({ where: { id: { in: [admin, member, guest, outsider] } } });
    });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("reaches every member's agents, with its credential, in each of its Spaces", async () => {
    const everything = { rows: 1, secrets: 1, servers: 1, serverSecrets: 1 };
    expect(await reachable(team, admin)).toEqual(everything);
    expect(await reachable(memberOwn, member)).toEqual(everything);
  });

  it("never reaches a guest or another organization", async () => {
    const nothing = { rows: 0, secrets: 0, servers: 0, serverSecrets: 0 };
    expect(await reachable(team, guest)).toEqual(nothing);
    expect(await reachable(outsiderSpace, outsider)).toEqual(nothing);
  });

  it("authorizes an organization model only for the selecting Space member", async () => {
    await runAsSystem("organization model fixture", async () => {
      const connection = await prisma.organizationModelConnection.create({
        data: {
          organizationId,
          provider: "example-provider",
          modelId: "example-model",
          label: "Team model",
          secretId: "fixture",
          ciphertext: "sealed",
        },
      });
      await prisma.spaceMember.update({
        where: { spaceId_userId: { spaceId: memberOwn, userId: member } },
        data: { organizationModelConnectionId: connection.id },
      });
      const resolve = (spaceId: string, userId: string) =>
        prisma.organizationModelConnection.findFirst({
          where: {
            id: connection.id,
            ...organizationModelConnectionIn({ spaceId, userId }, connection.id),
          },
          select: { id: true },
        });
      expect(await resolve(memberOwn, member)).toEqual({ id: connection.id });
      expect(await resolve(team, member)).toBeNull();
      expect(await resolve(team, guest)).toBeNull();
      expect(await resolve(outsiderSpace, outsider)).toBeNull();
      await prisma.member.updateMany({
        where: { userId: member, organizationId },
        data: { role: "guest" },
      });
      try {
        expect(await resolve(memberOwn, member)).toBeNull();
      } finally {
        await prisma.member.updateMany({
          where: { userId: member, organizationId },
          data: { role: "member" },
        });
      }
    });
  });

  it("is managed by the organization's admins alone", async () => {
    expect(await managedOrganizationId(prisma, { spaceId: memberOwn, userId: admin })).toBe(
      organizationId,
    );
    expect(await managedOrganizationId(prisma, { spaceId: memberOwn, userId: member })).toBeNull();
    expect(await managedOrganizationId(prisma, { spaceId: team, userId: guest })).toBeNull();
  });

  it("is found at its address in another spelling", async () => {
    const scope = { spaceId: memberOwn, userId: member };
    expect(
      await runAsTenant(scope, () =>
        organizationServerAt(prisma, scope, "HTTPS://tracker.example.test:443/mcp"),
      ),
    ).toEqual({ id: serverId, name: "Tracker" });
  });

  const claim = (spaceIds: string[]) => {
    const scope = { spaceId: spaceIds[0]!, userId: member };
    return runAsTenant(scope, () =>
      prisma.$transaction((tx) =>
        assertNameFreeWhereAvailable(tx, "mcpServer", scope, "tracker", {
          allSpaces: false,
          spaceIds,
        }),
      ),
    );
  };

  it("takes its name in its organization's Spaces", async () => {
    await expect(claim([memberOwn])).rejects.toMatchObject({ name: "NameTakenError" });
  });

  it("leaves its name free in another organization the member belongs to", async () => {
    await expect(claim([outsiderSpace])).resolves.toBeUndefined();
  });
});
