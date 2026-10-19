import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { createGroupRepos } from "./groups.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRepos } from "./repos.js";
import { IsolationError } from "./scope.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("deleteBotSection (PostgreSQL)", () => {
  const provider = "sendblue";
  const stamp = String(Date.now()).slice(-7);
  const ownerAddress = `+1555${stamp}`;
  const strangerAddress = `+1556${stamp}`;
  const neighborId = `section-neighbor-${stamp}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let owner: { userId: string; spaceId: string };
  let stranger: { userId: string; spaceId: string };

  const actorFor = (identity: { userId: string; spaceId: string }) => ({
    userId: identity.userId,
    spaceId: identity.spaceId,
    email: "sections@example.com",
    isDeploymentOwner: false,
  });
  const botInput = (name: string) => ({
    name,
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
  const signup = { signupsEnabled: undefined, signupAllowlist: undefined };

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    owner = await provisionMessagingIdentity(prisma, { provider, address: ownerAddress }, signup);
    stranger = await provisionMessagingIdentity(
      prisma,
      { provider, address: strangerAddress },
      signup,
    );
    await prisma.user.create({
      data: {
        id: neighborId,
        name: "Section Neighbor",
        email: `${neighborId}@rakazo.test`,
        emailVerified: false,
      },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.messagingIdentity.deleteMany({
        where: { provider, address: { in: [ownerAddress, strangerAddress] } },
      });
      const spaceIds = [owner?.spaceId, stranger?.spaceId].filter(Boolean) as string[];
      const userIds = [owner?.userId, stranger?.userId, neighborId].filter(Boolean) as string[];
      await prisma.organization.deleteMany({ where: { id: { in: spaceIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await close?.();
  });

  it("deletes the section and keeps its bots and groups, now unsectioned", async () => {
    const repos = createRepos(prisma);
    const actor = actorFor(owner);
    const first = await repos.createBot(actor, botInput("First"));
    const second = await repos.createBot(actor, botInput("Second"));
    const group = await createGroupRepos(prisma).createGroup(actor, {
      name: "Pair",
      botIds: [first.id, second.id],
    });
    const section = await repos.createBotSection(actor, { botId: first.id, name: "Doomed" });
    await prisma.chatGroup.update({ where: { id: group.id }, data: { sectionId: section.id } });

    await expect(repos.deleteBotSection(actor, { sectionId: section.id })).resolves.toEqual({
      id: section.id,
      releasedBots: 1,
      releasedGroups: 1,
    });

    expect(await prisma.botSection.findUnique({ where: { id: section.id } })).toBeNull();
    const [bot, chatGroup] = await Promise.all([
      prisma.bot.findUniqueOrThrow({ where: { id: first.id } }),
      prisma.chatGroup.findUniqueOrThrow({ where: { id: group.id } }),
    ]);
    expect(bot.sectionId).toBeNull();
    expect(bot.archivedAt).toBeNull();
    expect(chatGroup.sectionId).toBeNull();
    expect(chatGroup.archivedAt).toBeNull();
  });

  it("treats another user's section in the same space as not found", async () => {
    const neighborSection = await prisma.botSection.create({
      data: { spaceId: owner.spaceId, userId: neighborId, name: "Theirs" },
    });

    await expect(
      createRepos(prisma).deleteBotSection(actorFor(owner), { sectionId: neighborSection.id }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(
      await prisma.botSection.findUnique({ where: { id: neighborSection.id } }),
    ).not.toBeNull();
  });

  it("treats another space's section as not found", async () => {
    const repos = createRepos(prisma);
    const strangerBot = await repos.createBot(actorFor(stranger), botInput("Elsewhere"));
    const strangerSection = await repos.createBotSection(actorFor(stranger), {
      botId: strangerBot.id,
      name: "Far",
    });

    await expect(
      repos.deleteBotSection(actorFor(owner), { sectionId: strangerSection.id }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: strangerBot.id } })).sectionId).toBe(
      strangerSection.id,
    );
  });
});
