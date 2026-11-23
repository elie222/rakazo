import { randomBytes } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, bootstrapUserSpace, createDb, createOrganizationForUser } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { otherSpaceOfBot, otherSpaceOfGroup } from "./bot-space.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("the Space of a linked chat (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const users: string[] = [];
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let sequence = 0;

  async function signup(): Promise<Actor> {
    const userId = `bot-space-${++sequence}-${suffix}`;
    users.push(userId);
    const email = `${userId}@rakazo.test`;
    await system.user.create({ data: { id: userId, name: userId, email, emailVerified: false } });
    const { spaceId } = await bootstrapUserSpace(system, { id: userId });
    return { userId, spaceId, email, isDeploymentOwner: false };
  }

  const bot = (spaceId: string, userId: string) =>
    system.bot.create({ data: { spaceId, userId, name: "Scout", color: "blue" } });

  async function group(spaceId: string, userId: string, activeBots = 2) {
    const members = await Promise.all([bot(spaceId, userId), bot(spaceId, userId)]);
    await system.bot.updateMany({
      where: { id: { in: members.slice(activeBots).map((member) => member.id) } },
      data: { archivedAt: new Date() },
    });
    return system.chatGroup.create({
      data: {
        spaceId,
        userId,
        name: "Standup",
        members: { create: members.map((member) => ({ botId: member.id })) },
      },
    });
  }

  beforeAll(() => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
  });

  afterAll(async () => {
    if (!db) return;
    await system.organization.deleteMany({
      where: { members: { some: { userId: { in: users } } } },
    });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("finds the caller's bot in another organization and never another person's", async () => {
    const ada = await signup();
    const grace = await signup();
    const work = await createOrganizationForUser(system, { userId: ada.userId, name: "Work" });
    const adaWorkBot = await bot(work.defaultSpaceId, ada.userId);
    const adaHomeBot = await bot(ada.spaceId, ada.userId);
    const graceBot = await bot(grace.spaceId, grace.userId);

    await expect(otherSpaceOfBot(prisma, ada, adaWorkBot.id)).resolves.toBe(work.defaultSpaceId);
    await expect(otherSpaceOfBot(prisma, ada, adaHomeBot.id)).resolves.toBeUndefined();
    await expect(otherSpaceOfBot(prisma, ada, graceBot.id)).resolves.toBeUndefined();

    await system.bot.update({ where: { id: adaWorkBot.id }, data: { archivedAt: new Date() } });
    await expect(otherSpaceOfBot(prisma, ada, adaWorkBot.id)).resolves.toBeUndefined();
    await system.bot.update({ where: { id: adaWorkBot.id }, data: { archivedAt: null } });
    await system.space.update({
      where: { id: work.defaultSpaceId },
      data: { deletingAt: new Date() },
    });
    await expect(otherSpaceOfBot(prisma, ada, adaWorkBot.id)).resolves.toBeUndefined();
  });

  it("finds a group in another organization of the caller's, and answers alike for one they cannot open and one that does not exist", async () => {
    const ada = await signup();
    const grace = await signup();
    const work = await createOrganizationForUser(system, { userId: ada.userId, name: "Work" });
    const adaWorkGroup = await group(work.defaultSpaceId, ada.userId);
    const adaHomeGroup = await group(ada.spaceId, ada.userId);
    const graceGroup = await group(grace.spaceId, grace.userId);
    const unopenable = await group(work.defaultSpaceId, ada.userId, 1);

    await expect(otherSpaceOfGroup(prisma, ada, adaWorkGroup.id)).resolves.toBe(
      work.defaultSpaceId,
    );
    await expect(otherSpaceOfGroup(prisma, ada, adaHomeGroup.id)).resolves.toBeUndefined();
    await expect(otherSpaceOfGroup(prisma, ada, unopenable.id)).resolves.toBeUndefined();
    const missing = await otherSpaceOfGroup(prisma, ada, `missing-${suffix}`);
    expect(missing).toBeUndefined();
    await expect(otherSpaceOfGroup(prisma, ada, graceGroup.id)).resolves.toBe(missing);
    await expect(otherSpaceOfGroup(prisma, grace, adaWorkGroup.id)).resolves.toBe(missing);

    await system.chatGroup.update({
      where: { id: adaWorkGroup.id },
      data: { archivedAt: new Date() },
    });
    await expect(otherSpaceOfGroup(prisma, ada, adaWorkGroup.id)).resolves.toBeUndefined();
    await system.chatGroup.update({ where: { id: adaWorkGroup.id }, data: { archivedAt: null } });
    await system.space.update({
      where: { id: work.defaultSpaceId },
      data: { deletingAt: new Date() },
    });
    await expect(otherSpaceOfGroup(prisma, ada, adaWorkGroup.id)).resolves.toBeUndefined();
  });
});
