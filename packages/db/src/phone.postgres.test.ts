import { afterAll, describe, expect, it } from "vitest";
import { createDb, type PrismaClient } from "./client.js";
import { provisionPhoneIdentity } from "./phone.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("provisionPhoneIdentity (PostgreSQL)", () => {
  const phone = "+15550001111";
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let provisioned: { userId: string; workspaceId: string; botId: string } | null = null;

  afterAll(async () => {
    if (provisioned) {
      await prisma.phoneIdentity.deleteMany({ where: { phoneE164: phone } });
      await prisma.organization.deleteMany({ where: { id: provisioned.workspaceId } });
      await prisma.user.deleteMany({ where: { id: provisioned.userId } });
    }
    await close?.();
  });

  it("provisions a user, workspace, bot, thread, and phone identity row", async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };

    const result = await provisionPhoneIdentity(prisma, phone, {
      signupsEnabled: undefined,
      signupAllowlist: undefined,
    });
    provisioned = result;

    expect(result.created).toBe(true);
    expect(result.phoneE164).toBe(phone);

    const user = await prisma.user.findUnique({
      where: { id: result.userId },
      include: { accounts: true, members: true },
    });
    expect(user).toBeTruthy();
    expect(user!.email).toBe("phone-15550001111@phone.invalid");
    expect(user!.accounts).toHaveLength(0);
    expect(user!.members).toHaveLength(1);
    expect(user!.members[0]!.organizationId).toBe(result.workspaceId);
    expect(user!.members[0]!.role).toBe("owner");

    const org = await prisma.organization.findUnique({ where: { id: result.workspaceId } });
    expect(org!.name).toBe("Personal");
    expect(org!.slug).toBe(`user-${result.userId.slice(0, 12)}`);

    const bot = await prisma.bot.findUnique({
      where: { id: result.botId },
      include: { thread: true },
    });
    expect(bot).toBeTruthy();
    expect(bot!.workspaceId).toBe(result.workspaceId);
    expect(bot!.userId).toBe(result.userId);
    expect(bot!.thread).toBeTruthy();
    expect(result.threadId).toBe(bot!.thread!.id);

    const identity = await prisma.phoneIdentity.findUnique({ where: { phoneE164: phone } });
    expect(identity).toBeTruthy();
    expect(identity!.userId).toBe(result.userId);
    expect(identity!.workspaceId).toBe(result.workspaceId);
    expect(identity!.botId).toBe(result.botId);
    expect(identity!.outboundSinceInbound).toBe(0);
    expect(identity!.verifiedAt).toBeNull();

    // bootstrap parity: same surrounding rows the auth signup hook creates
    const memories = await prisma.memoryDocument.findMany({
      where: { workspaceId: result.workspaceId, userId: result.userId },
    });
    expect(memories.some((m) => m.scope === "user" && m.path === "MEMORY.md")).toBe(true);
    expect(memories.some((m) => m.scope === "bot" && m.botId === result.botId)).toBe(true);
    const pref = await prisma.notificationPreference.findFirst({
      where: { workspaceId: result.workspaceId, userId: result.userId },
    });
    expect(pref).toBeTruthy();
  });

  it("does not let a texter claim deployment ownership", async () => {
    const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
    expect(settings?.ownerUserId ?? null).not.toBe(provisioned!.userId);
  });

  it("is idempotent for a repeat inbound from the same number", async () => {
    const again = await provisionPhoneIdentity(prisma, phone, {
      signupsEnabled: undefined,
      signupAllowlist: undefined,
    });

    expect(again.created).toBe(false);
    expect(again.userId).toBe(provisioned!.userId);
    expect(again.workspaceId).toBe(provisioned!.workspaceId);
    expect(again.botId).toBe(provisioned!.botId);

    const users = await prisma.user.findMany({
      where: { email: "phone-15550001111@phone.invalid" },
    });
    expect(users).toHaveLength(1);
    const identities = await prisma.phoneIdentity.findMany({ where: { phoneE164: phone } });
    expect(identities).toHaveLength(1);
  });

  it("resumes after a partial first attempt that only created the user row", async () => {
    const partialPhone = "+15550002222";
    // Simulates a crash between user.create and bootstrapUserWorkspace.
    const orphan = await prisma.user.create({
      data: {
        id: `partial${Date.now()}`,
        name: "Phone 2222",
        email: "phone-15550002222@phone.invalid",
        emailVerified: false,
      },
    });
    try {
      const result = await provisionPhoneIdentity(prisma, partialPhone, {
        signupsEnabled: undefined,
        signupAllowlist: undefined,
      });

      expect(result.created).toBe(true);
      expect(result.userId).toBe(orphan.id);
      const identity = await prisma.phoneIdentity.findUnique({
        where: { phoneE164: partialPhone },
      });
      expect(identity).toBeTruthy();
      const bots = await prisma.bot.findMany({
        where: { workspaceId: result.workspaceId, userId: orphan.id },
      });
      expect(bots).toHaveLength(1);

      await prisma.phoneIdentity.deleteMany({ where: { phoneE164: partialPhone } });
      await prisma.organization.deleteMany({ where: { id: result.workspaceId } });
    } finally {
      await prisma.user.deleteMany({ where: { id: orphan.id } });
    }
  });

  it("resumes after a partial attempt that reached createBot, reusing the orphaned bot", async () => {
    const partialPhone = "+15550003333";
    // First attempt: let it provision fully, then delete only the identity row.
    const first = await provisionPhoneIdentity(prisma, partialPhone, {
      signupsEnabled: undefined,
      signupAllowlist: undefined,
    });
    await prisma.phoneIdentity.deleteMany({ where: { phoneE164: partialPhone } });
    try {
      const second = await provisionPhoneIdentity(prisma, partialPhone, {
        signupsEnabled: undefined,
        signupAllowlist: undefined,
      });

      expect(second.userId).toBe(first.userId);
      expect(second.workspaceId).toBe(first.workspaceId);
      expect(second.botId).toBe(first.botId);
      const bots = await prisma.bot.findMany({
        where: { workspaceId: first.workspaceId, userId: first.userId },
      });
      expect(bots).toHaveLength(1);
    } finally {
      await prisma.phoneIdentity.deleteMany({ where: { phoneE164: partialPhone } });
      await prisma.organization.deleteMany({ where: { id: first.workspaceId } });
      await prisma.user.deleteMany({ where: { id: first.userId } });
    }
  });
});
