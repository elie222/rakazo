import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listMessagePins, setMessagePin } from "./thread-pins.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("conversation message pins (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(() => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
  });

  afterAll(async () => {
    await close?.();
  });

  it("only pins messages from the named chat, including messages outside its latest page", async () => {
    const identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(prisma, { provider: "test", address: `pins-${randomUUID()}` }),
    );
    const { spaceId, userId, threadId } = identity;
    try {
      const otherBot = await system.bot.create({
        data: {
          spaceId,
          userId,
          name: "Other bot",
          color: "primary",
          thread: { create: { spaceId, userId } },
        },
        select: { thread: { select: { id: true } } },
      });
      const saved = await system.message.create({
        data: {
          threadId,
          seq: 0,
          role: "user",
          blocks: [{ kind: "text", text: "Launch checklist" }],
        },
      });
      const foreign = await system.message.create({
        data: {
          threadId: otherBot.thread!.id,
          seq: 0,
          role: "user",
          blocks: [{ kind: "text", text: "Other chat" }],
        },
      });
      await system.message.createMany({
        data: Array.from({ length: 101 }, (_, index) => ({
          threadId,
          seq: index + 1,
          role: "user",
          blocks: [{ kind: "text", text: "Later message" }],
        })),
      });

      await runAsTenant({ spaceId, userId }, async () => {
        await expect(setMessagePin(prisma, threadId, foreign.id, true)).rejects.toMatchObject({
          kind: "NOT_FOUND",
        });
        await setMessagePin(prisma, threadId, saved.id, true);
        await expect(listMessagePins(prisma, threadId)).resolves.toEqual([
          { messageId: saved.id, text: "Launch checklist" },
        ]);
      });
    } finally {
      await system.messagingIdentity.deleteMany({ where: { userId } });
      await system.organization.deleteMany({ where: { id: spaceId } });
      await system.user.deleteMany({ where: { id: userId } });
    }
  });
});
