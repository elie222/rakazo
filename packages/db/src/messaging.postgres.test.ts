import { afterAll, describe, expect, it } from "vitest";
import { createDb, type PrismaClient } from "./client.js";
import { provisionMessagingIdentity } from "./messaging.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("provisionMessagingIdentity (PostgreSQL)", () => {
  const provider = "sendblue";
  const address = "+15550001111";
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let provisioned: { userId: string; spaceId: string; botId: string } | null = null;

  afterAll(async () => {
    if (provisioned) {
      await prisma.messagingIdentity.deleteMany({ where: { provider, address } });
      await prisma.organization.deleteMany({ where: { id: provisioned.spaceId } });
      await prisma.user.deleteMany({ where: { id: provisioned.userId } });
    }
    await close?.();
  });

  it("provisions a user, workspace, bot, thread, and messaging identity row", async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };

    const result = await provisionMessagingIdentity(
      prisma,
      { provider, address },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    provisioned = result;

    expect(result.created).toBe(true);
    expect(result.provider).toBe(provider);
    expect(result.address).toBe(address);

    const user = await prisma.user.findUnique({
      where: { id: result.userId },
      include: { accounts: true, members: true },
    });
    expect(user).toBeTruthy();
    expect(user!.email).toBe("msg-sendblue15550001111@messaging.invalid");
    expect(user!.accounts).toHaveLength(0);
    expect(user!.members).toHaveLength(1);
    expect(user!.members[0]!.organizationId).toBe(result.spaceId);
    expect(user!.members[0]!.role).toBe("owner");

    const org = await prisma.organization.findUnique({ where: { id: result.spaceId } });
    expect(org!.name).toBe("Personal");
    expect(org!.slug).toBe(`user-${result.userId.slice(0, 12)}`);

    const space = await prisma.space.findUnique({
      where: { id: result.spaceId },
      include: { memberships: true },
    });
    expect(space).toMatchObject({
      organizationId: org!.id,
      name: "Personal",
    });
    expect(space!.memberships).toEqual([expect.objectContaining({ userId: result.userId })]);

    const bot = await prisma.bot.findUnique({
      where: { id: result.botId },
      include: { thread: true },
    });
    expect(bot).toBeTruthy();
    expect(bot!.spaceId).toBe(result.spaceId);
    expect(bot!.userId).toBe(result.userId);
    expect(bot!.thread).toBeTruthy();
    expect(result.threadId).toBe(bot!.thread!.id);

    const identity = await prisma.messagingIdentity.findUnique({
      where: { provider_address: { provider, address } },
    });
    expect(identity).toBeTruthy();
    expect(identity!.userId).toBe(result.userId);
    expect(identity!.spaceId).toBe(result.spaceId);
    expect(identity!.botId).toBe(result.botId);
    expect(identity!.dmThreadId).toBeNull();
    expect(identity!.outboundSinceInbound).toBe(0);
    expect(identity!.verifiedAt).toBeNull();

    // bootstrap parity: same surrounding rows the auth signup hook creates
    const memories = await prisma.memoryDocument.findMany({
      where: { spaceId: result.spaceId, userId: result.userId },
    });
    expect(memories.some((m) => m.scope === "user" && m.path === "MEMORY.md")).toBe(true);
    expect(memories.some((m) => m.scope === "bot" && m.botId === result.botId)).toBe(true);
    const pref = await prisma.notificationPreference.findFirst({
      where: { spaceId: result.spaceId, userId: result.userId },
    });
    expect(pref).toBeTruthy();
  });

  it("does not let a texter claim deployment ownership", async () => {
    const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
    expect(settings?.ownerUserId ?? null).not.toBe(provisioned!.userId);
  });

  it("is idempotent for a repeat inbound from the same address", async () => {
    const again = await provisionMessagingIdentity(
      prisma,
      { provider, address },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );

    expect(again.created).toBe(false);
    expect(again.userId).toBe(provisioned!.userId);
    expect(again.spaceId).toBe(provisioned!.spaceId);
    expect(again.botId).toBe(provisioned!.botId);

    const users = await prisma.user.findMany({
      where: { email: "msg-sendblue15550001111@messaging.invalid" },
    });
    expect(users).toHaveLength(1);
    const identities = await prisma.messagingIdentity.findMany({ where: { provider, address } });
    expect(identities).toHaveLength(1);
  });

  it("resumes after a partial first attempt that only created the user row", async () => {
    const partialAddress = "+15550002222";
    // Simulates a crash between user.create and bootstrapUserSpace.
    const orphan = await prisma.user.create({
      data: {
        id: `partial${Date.now()}`,
        name: "Sendblue 2222",
        email: "msg-sendblue15550002222@messaging.invalid",
        emailVerified: false,
      },
    });
    try {
      const result = await provisionMessagingIdentity(
        prisma,
        { provider, address: partialAddress },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      );

      expect(result.created).toBe(true);
      expect(result.userId).toBe(orphan.id);
      const identity = await prisma.messagingIdentity.findUnique({
        where: { provider_address: { provider, address: partialAddress } },
      });
      expect(identity).toBeTruthy();
      const bots = await prisma.bot.findMany({
        where: { spaceId: result.spaceId, userId: orphan.id },
      });
      expect(bots).toHaveLength(1);

      await prisma.messagingIdentity.deleteMany({ where: { provider, address: partialAddress } });
      await prisma.organization.deleteMany({ where: { id: result.spaceId } });
    } finally {
      await prisma.user.deleteMany({ where: { id: orphan.id } });
    }
  });

  it("resumes after a partial attempt that reached createBot, reusing the orphaned bot", async () => {
    const partialAddress = "+15550003333";
    // First attempt: let it provision fully, then delete only the identity row.
    const first = await provisionMessagingIdentity(
      prisma,
      { provider, address: partialAddress },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    await prisma.messagingIdentity.deleteMany({ where: { provider, address: partialAddress } });
    try {
      const second = await provisionMessagingIdentity(
        prisma,
        { provider, address: partialAddress },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      );

      expect(second.userId).toBe(first.userId);
      expect(second.spaceId).toBe(first.spaceId);
      expect(second.botId).toBe(first.botId);
      const bots = await prisma.bot.findMany({
        where: { spaceId: first.spaceId, userId: first.userId },
      });
      expect(bots).toHaveLength(1);
    } finally {
      await prisma.messagingIdentity.deleteMany({ where: { provider, address: partialAddress } });
      await prisma.organization.deleteMany({ where: { id: first.spaceId } });
      await prisma.user.deleteMany({ where: { id: first.userId } });
    }
  });
});
