import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reserveBotEmailSend } from "./bot-email-sends.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { asSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("bot email send limits (PostgreSQL)", () => {
  const userId = `email-sends-${process.pid}-${Date.now()}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await asSystem(prisma).user.create({
      data: { id: userId, name: "Sender", email: `${userId}@example.test`, emailVerified: true },
    });
  });
  afterAll(async () => {
    if (!prisma) return;
    await asSystem(prisma).user.deleteMany({ where: { id: userId } });
    await close();
  });

  beforeEach(async () => {
    const system = asSystem(prisma);
    await system.botEmailSend.deleteMany({ where: { userId } });
    await system.user.update({
      where: { id: userId },
      data: {
        emailVerified: true,
        deactivatedAt: null,
        botEmailDailyLimit: 5,
        botEmailRepliesEnabled: false,
        botEmailAllowedRecipients: [],
      },
    });
  });

  const reserve = (
    botId: string,
    spaceId: string,
    recipients = [`${userId}@example.test`],
    verifiedReplySender?: string,
    now?: Date,
  ) =>
    runAsTenant({ spaceId, userId }, () =>
      reserveBotEmailSend(prisma, { userId, botId, recipients, verifiedReplySender }, now),
    );

  it("shares five deliveries across concurrent bots in different Spaces", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => reserve(`bot-${index}`, `space-${index}`)),
    );
    expect(results.filter((result) => typeof result === "object")).toHaveLength(5);
    expect(results.filter((result) => result === "limit")).toHaveLength(7);
    expect(await reserve("new-bot", "new-space")).toBe("limit");
  });

  it("charges every recipient and refuses a send that would exceed the allowance", async () => {
    await asSystem(prisma).user.update({
      where: { id: userId },
      data: { botEmailRepliesEnabled: true },
    });
    const recipients = [`${userId}@example.test`, "sender@example.test"];
    expect(await reserve("bot", "space", recipients, "sender@example.test")).toHaveProperty("id");
    expect(await reserve("bot", "space", recipients, "sender@example.test")).toHaveProperty("id");
    expect(await reserve("bot", "space", recipients, "sender@example.test")).toBe("limit");
    expect(await reserve("bot", "space")).toHaveProperty("id");
    const total = await asSystem(prisma).botEmailSend.aggregate({
      where: { userId },
      _sum: { recipientCount: true },
    });
    expect(total._sum.recipientCount).toBe(5);
  });

  it("requires a verified active owner, permits only the owner by default, and supports a pause", async () => {
    expect(await reserve("bot", "space", ["stranger@example.test"], "stranger@example.test")).toBe(
      "recipient",
    );
    await asSystem(prisma).user.update({ where: { id: userId }, data: { emailVerified: false } });
    expect(await reserve("bot", "space")).toBe("unverified");
    await asSystem(prisma).user.update({
      where: { id: userId },
      data: { emailVerified: true, deactivatedAt: new Date() },
    });
    expect(await reserve("bot", "space")).toBe("disabled");
    await asSystem(prisma).user.update({
      where: { id: userId },
      data: { deactivatedAt: null, botEmailDailyLimit: 0 },
    });
    expect(await reserve("bot", "space")).toBe("disabled");
    expect(await asSystem(prisma).botEmailSend.count({ where: { userId } })).toBe(0);
  });

  it("honors operator-approved recipients and their revocation without granting other addresses", async () => {
    await asSystem(prisma).user.update({
      where: { id: userId },
      data: { botEmailAllowedRecipients: ["reports@example.test"] },
    });
    expect(await reserve("bot", "space", ["reports@example.test"])).toHaveProperty("id");
    expect(await reserve("bot", "space", ["other@example.test"])).toBe("recipient");
    await asSystem(prisma).user.update({
      where: { id: userId },
      data: { botEmailAllowedRecipients: [] },
    });
    expect(await reserve("bot", "space", ["reports@example.test"])).toBe("recipient");
  });

  it("uses a rolling window and applies manual increases without clearing previous usage", async () => {
    const now = new Date("2026-11-12T12:00:00Z");
    await asSystem(prisma).botEmailSend.createMany({
      data: [
        {
          userId,
          botId: "deleted",
          sentAt: new Date(now.getTime() - 86_400_001),
          recipientCount: 5,
        },
        { userId, botId: "other", sentAt: new Date(now.getTime() - 1_000), recipientCount: 5 },
      ],
    });
    expect(await reserve("bot", "space", undefined, undefined, now)).toBe("limit");
    await asSystem(prisma).user.update({ where: { id: userId }, data: { botEmailDailyLimit: 6 } });
    expect(await reserve("bot", "space", undefined, undefined, now)).toHaveProperty("id");
    expect(await reserve("bot", "space", undefined, undefined, now)).toBe("limit");
    expect(
      await reserve("bot", "space", undefined, undefined, new Date(now.getTime() + 86_400_001)),
    ).toHaveProperty("id");
  });
});
