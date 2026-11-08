import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reserveBotEmailSend } from "./bot-email-sends.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { asSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("bot email send limits (PostgreSQL)", () => {
  const userId = `email-sends-${process.pid}-${Date.now()}`;
  const limits = { bot: 3, owner: 5 };
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
      data: { id: userId, name: "Sender", email: `${userId}@example.test` },
    });
  });
  afterAll(async () => {
    if (!prisma) return;
    await asSystem(prisma).user.deleteMany({ where: { id: userId } });
    await close();
  });

  // Tenant contexts of different Spaces, as runs in each would have.
  const reserve = (botId: string, spaceId: string) =>
    runAsTenant({ spaceId, userId }, () => reserveBotEmailSend(prisma, { userId, botId }, limits));

  it("lets parallel sends past neither the bot's nor the owner's limit, in any Space", async () => {
    const first = await Promise.all(Array.from({ length: 8 }, () => reserve("bot-a", "space-a")));
    expect(first.filter((result) => typeof result === "object")).toHaveLength(3);
    expect(first.filter((result) => result === "bot")).toHaveLength(5);

    // A new bot in another Space, as after deleting the first, still shares the owner's limit.
    const second = await Promise.all(Array.from({ length: 8 }, () => reserve("bot-b", "space-b")));
    expect(second.filter((result) => typeof result === "object")).toHaveLength(2);
    expect(await reserve("bot-c", "space-c")).toBe("owner");
  });
});
