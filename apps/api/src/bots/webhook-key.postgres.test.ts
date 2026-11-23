import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, bootstrapUserSpace, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("making a bot's webhook key (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let actor: Actor;
  const userId = `webhook-key-${randomUUID().slice(0, 8)}`;
  // Every call reaches the transaction before any saves, as two devices asking at once would.
  let callers = 0;
  const bothStoring = deferred();
  const secrets = {
    put: async () => {
      if (++callers === 2) bothStoring.resolve();
      await bothStoring.promise;
      return { id: randomUUID(), ciphertext: "sealed", ref: "sealed" };
    },
    load: async () => "unused",
  };
  const client = () =>
    createRouterClient(createRouter({ prisma, env: {}, secrets } as unknown as RouterDeps), {
      context: { actor },
    });

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    const email = `${userId}@rakazo.test`;
    await system.user.create({ data: { id: userId, name: userId, email, emailVerified: false } });
    const { spaceId } = await bootstrapUserSpace(system, { id: userId });
    actor = { userId, spaceId, email, isDeploymentOwner: false };
  });

  afterAll(async () => {
    if (!db) return;
    await system.organization.deleteMany({ where: { members: { some: { userId } } } });
    await system.user.deleteMany({ where: { id: userId } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("makes one key when two calls race, and keeps it after", async () => {
    const bot = await system.bot.create({
      data: { spaceId: actor.spaceId, userId, name: "Scout", color: "blue" },
    });
    const results = await Promise.all([
      client().bots.ensureWebhookSecret({ botId: bot.id }),
      client().bots.ensureWebhookSecret({ botId: bot.id }),
    ]);
    expect(results.filter((result) => result.secret)).toHaveLength(1);
    const keys = () => system.secret.findMany({ where: { userId, kind: "webhook" } });
    const [key] = await keys();
    expect(await keys()).toHaveLength(1);
    expect((await system.bot.findUniqueOrThrow({ where: { id: bot.id } })).webhookSecretId).toBe(
      key!.id,
    );

    const again = await client().bots.ensureWebhookSecret({ botId: bot.id });
    expect(again.secret).toBeUndefined();
    expect((await keys()).map(({ id }) => id)).toEqual([key!.id]);
  });
});
