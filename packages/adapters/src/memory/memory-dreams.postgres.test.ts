import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pruneMemoryDreams } from "./memory-dreams.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

const organizationId = "dream-prune-org";
const userId = "dream-prune-user";
const limitedSpaceId = "dream-prune-limited";
const defaultSpaceId = "dream-prune-default";
const limitedBotId = "dream-prune-limited-bot";
const defaultBotId = "dream-prune-default-bot";

describePostgres("pruning dreams (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await asSystem(prisma).organization.create({
      data: {
        id: organizationId,
        name: "Dream Prune",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await asSystem(prisma).space.createMany({
      data: [
        {
          id: limitedSpaceId,
          organizationId,
          name: "Keeps twenty",
          dreamRetention: 20,
        },
        { id: defaultSpaceId, organizationId, name: "Keeps the default" },
      ],
    });
    await asSystem(prisma).bot.createMany({
      data: [
        { id: limitedBotId, spaceId: limitedSpaceId, userId, name: "Sweep", color: "ink" },
        { id: defaultBotId, spaceId: defaultSpaceId, userId, name: "Default", color: "ink" },
      ],
    });
    for (const [spaceId, botId, count] of [
      [limitedSpaceId, limitedBotId, 30],
      [defaultSpaceId, defaultBotId, 3],
    ] as const) {
      for (let index = 0; index < count; index += 1) {
        const thread = await asSystem(prisma).thread.create({
          data: { spaceId, userId, helperBotId: botId },
          select: { id: true },
        });
        await asSystem(prisma).memoryDream.create({
          data: {
            spaceId,
            botId,
            threadId: thread.id,
            status: "completed",
            createdAt: new Date(Date.UTC(2026, 0, index + 1)),
          },
        });
      }
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await asSystem(prisma).organization.deleteMany({ where: { id: organizationId } });
    } finally {
      await close();
    }
  });

  it("keeps each Space's own limit and deletes the hidden threads it drops", async () => {
    await pruneMemoryDreams(prisma);
    const kept = await asSystem(prisma).memoryDream.findMany({
      where: { spaceId: limitedSpaceId },
      select: { id: true },
    });
    expect(kept).toHaveLength(20);
    // The newest twenty survive; their hidden threads go with the ten dropped records.
    expect(await asSystem(prisma).thread.count({ where: { spaceId: limitedSpaceId } })).toBe(20);
  });

  it("keeps the default when a Space sets no limit", async () => {
    expect(await asSystem(prisma).memoryDream.count({ where: { spaceId: defaultSpaceId } })).toBe(
      3,
    );
  });
});
