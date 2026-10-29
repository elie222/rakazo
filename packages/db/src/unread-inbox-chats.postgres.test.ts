import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { asSystem, runAsTenant } from "./row-security.js";
import { countUnreadInboxChats } from "./unread-inbox-chats.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("unread inbox chat count (PostgreSQL)", () => {
  const suffix = randomUUID();
  const userId = `badge-user-${suffix}`;
  const otherUserId = `badge-peer-${suffix}`;
  const organizationIds = [`badge-org-${suffix}`, `badge-other-org-${suffix}`];
  const spaceIds = [0, 1, 2, 3].map((n) => `badge-space-${n}-${suffix}`);
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    const fixture = asSystem(prisma);
    for (const id of [userId, otherUserId]) {
      await fixture.user.create({
        data: { id, name: "Badge fixture", email: `${id}@example.test`, emailVerified: false },
      });
    }
    for (const id of organizationIds) {
      await fixture.organization.create({
        data: { id, name: "Badge fixture", slug: id, createdAt: new Date() },
      });
      for (const member of [userId, otherUserId]) {
        await fixture.member.create({
          data: {
            id: randomUUID(),
            organizationId: id,
            userId: member,
            role: "member",
            createdAt: new Date(),
          },
        });
      }
    }
    for (const [index, id] of spaceIds.entries()) {
      const organizationId = organizationIds[index === 2 ? 1 : 0]!;
      await fixture.space.create({ data: { id, organizationId, name: "Badge fixture" } });
      for (const member of index === 3 ? [otherUserId] : [userId, otherUserId]) {
        await fixture.spaceMember.create({
          data: {
            id: randomUUID(),
            organizationId,
            spaceId: id,
            userId: member,
            createdAt: new Date(),
          },
        });
      }
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    await asSystem(prisma).chatGroupMember.deleteMany({
      where: { group: { spaceId: { in: spaceIds } } },
    });
    await asSystem(prisma).organization.deleteMany({ where: { id: { in: organizationIds } } });
    await asSystem(prisma).user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await close();
  });

  async function bot(spaceId: string, owner = userId, unread = true, archived = false) {
    return asSystem(prisma).bot.create({
      data: {
        spaceId,
        userId: owner,
        name: "Fixture",
        color: "blue",
        archivedAt: archived ? new Date() : null,
        thread: { create: { spaceId, userId: owner, unread } },
      },
      include: { thread: true },
    });
  }

  async function group(
    spaceId: string,
    active: number,
    unread = true,
    archived = false,
    owner = userId,
  ) {
    const members = await Promise.all([0, 1].map((i) => bot(spaceId, owner, false, i >= active)));
    await asSystem(prisma).chatGroup.create({
      data: {
        spaceId,
        userId: owner,
        name: "Fixture",
        archivedAt: archived ? new Date() : null,
        members: { create: members.map((member) => ({ botId: member.id })) },
        thread: { create: { spaceId, userId: owner, unread } },
      },
    });
  }

  it("matches the inbox across member Spaces without counting hidden or other users' chats", async () => {
    for (const spaceId of spaceIds.slice(0, 2)) {
      await bot(spaceId);
      await group(spaceId, 2);
    }
    const spaceId = spaceIds[0]!;
    await bot(spaceId, userId, false);
    await bot(spaceId, userId, true, true);
    await group(spaceId, 2, false);
    await group(spaceId, 2, true, true);
    await group(spaceId, 1);
    await group(spaceId, 0);
    await bot(spaceId, otherUserId);
    await group(spaceId, 2, true, false, otherUserId);
    await bot(spaceIds[2]!);
    await bot(spaceIds[3]!);
    const externalBot = await bot(spaceId, userId, false);
    await asSystem(prisma).externalConversation.create({
      data: {
        provider: "fixture",
        workspaceId: suffix,
        externalKey: "fixture",
        conversationId: "fixture",
        spaceId,
        botId: externalBot.id,
        userId,
        thread: { create: { spaceId, userId, unread: true } },
      },
    });
    await expect(
      runAsTenant({ spaceId, userId }, () => countUnreadInboxChats(prisma, { spaceId, userId })),
    ).resolves.toBe(4);
    await expect(countUnreadInboxChats(prisma, { spaceId: spaceIds[2]!, userId })).resolves.toBe(1);
  });
});
