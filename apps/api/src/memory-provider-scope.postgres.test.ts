import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import {
  asSystem,
  bootstrapUserSpace,
  commitBotUpdate,
  createDb,
  Prisma,
  type PrismaClient,
  runAsTenant,
} from "@rakazo/db";
import { expect, it, vi } from "vitest";
import {
  assertMemoryScopeSupported,
  persistMemoryProviderConfig,
} from "./memory-provider-config.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function fixture(prisma: PrismaClient) {
  const userId = randomUUID();
  await prisma.user.create({
    data: { id: userId, name: "Scope test", email: `${userId}@example.test`, emailVerified: false },
  });
  const { spaceId } = await bootstrapUserSpace(
    prisma,
    { id: userId },
    { signupsEnabled: "true", signupAllowlist: "" },
  );
  const actor: Actor = {
    userId,
    spaceId,
    email: `${userId}@example.test`,
    isDeploymentOwner: false,
  };
  const bot = await prisma.bot.create({
    data: {
      spaceId,
      userId,
      name: "Scope bot",
      color: "ink",
      thread: { create: { spaceId, userId } },
    },
    include: { thread: true },
  });
  return { actor, bot };
}

function deps(prisma: PrismaClient) {
  return {
    prisma,
    secrets: { put: vi.fn(async () => ({ id: randomUUID(), ciphertext: "fake-ciphertext" })) },
    classifySettings: async (_provider: string, settings: Record<string, string>) => settings,
    prepareConnection: async (input: {
      provider: string;
      settings: Record<string, string>;
      credentials: Record<string, string>;
    }) => ({ provider: input.provider, settings: input.settings, credentials: input.credentials }),
  };
}

function input(actor: Actor) {
  return {
    provider: "rembric",
    settings: { endpoint: `https://memory.example.test/mcp/space-${actor.spaceId}` },
    credentials: { token: "fake-token" },
    defaultMemoryScope: "shared" as const,
    confirmSharedScope: true,
  };
}

// Inspect real lock waiters, not timing: the losing transaction has actually reached PostgreSQL.
async function waitForScopeWaiter(prisma: PrismaClient, spaceId: string) {
  await vi.waitFor(
    async () => {
      const rows = await prisma.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND classid = ((hashtextextended(${spaceId}, 0) >> 32) & 4294967295)::oid
          AND objid = (hashtextextended(${spaceId}, 0) & 4294967295)::oid
      ) AS waiting
    `);
      expect(rows[0]?.waiting).toBe(true);
    },
    { timeout: 3000, interval: 10 },
  );
}

it.skipIf(!databaseUrl).each([false, true])(
  "connect winning the scope lock rejects a waiting isolated update (profile event=%s)",
  async (emitBotUpdated) => {
    const db = createDb(databaseUrl!);
    const prisma = asSystem(db.prisma);
    const locked = gate();
    const release = gate();
    const operations: Promise<unknown>[] = [];
    try {
      const { actor, bot } = await fixture(prisma);
      // Hold the real connect transaction immediately after its lock and config read.
      const paused = new Proxy(prisma, {
        get(target, key) {
          if (key !== "$transaction") return Reflect.get(target, key);
          return (run: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) =>
            target.$transaction(
              async (tx) => {
                const wrapped = new Proxy(tx, {
                  get(client, field) {
                    if (field !== "spaceMemoryConfig") return Reflect.get(client, field);
                    return new Proxy(client.spaceMemoryConfig, {
                      get(model, method) {
                        if (method !== "findUnique") return Reflect.get(model, method);
                        return async (...args: Parameters<typeof model.findUnique>) => {
                          const config = await model.findUnique(...args);
                          locked.open();
                          await release.promise;
                          return config;
                        };
                      },
                    });
                  },
                });
                return run(wrapped);
              },
              options as { isolationLevel: Prisma.TransactionIsolationLevel },
            );
        },
      });
      const connect = persistMemoryProviderConfig(deps(paused), actor, input(actor));
      operations.push(connect);
      await locked.promise;
      const update = commitBotUpdate({
        prisma,
        notify: async () => {},
        spaceId: actor.spaceId,
        threadId: bot.thread!.id,
        botId: bot.id,
        data: { memoryScope: "isolated", ...(emitBotUpdated ? { title: "Changed" } : {}) },
        emitBotUpdated,
        beforeWrite: (tx) => assertMemoryScopeSupported(tx, actor.spaceId, "isolated"),
      });
      // Attach rejection handling before releasing either operation.
      const rejected = expect(update).rejects.toMatchObject({ code: "BAD_REQUEST" });
      operations.push(update);
      await waitForScopeWaiter(prisma, actor.spaceId);
      // Control: a separate Space's valid shared update is not blocked by this lock.
      const other = await fixture(prisma);
      await commitBotUpdate({
        prisma,
        notify: async () => {},
        spaceId: other.actor.spaceId,
        threadId: other.bot.thread!.id,
        botId: other.bot.id,
        data: { memoryScope: "shared" },
        emitBotUpdated: false,
      });
      release.open();
      await connect;
      await rejected;
      expect(await prisma.bot.findUnique({ where: { id: bot.id } })).toMatchObject({
        memoryScope: null,
        title: "",
      });
      expect(await prisma.event.count({ where: { threadId: bot.thread!.id } })).toBe(0);
    } finally {
      release.open();
      await Promise.allSettled(operations);
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  },
  15000,
);

it.skipIf(!databaseUrl)(
  "an isolated update winning the lock rejects waiting connect; shared control connects",
  async () => {
    const db = createDb(databaseUrl!);
    const prisma = asSystem(db.prisma);
    const locked = gate();
    const release = gate();
    const operations: Promise<unknown>[] = [];
    try {
      const { actor, bot } = await fixture(prisma);
      const update = commitBotUpdate({
        prisma,
        notify: async () => {},
        spaceId: actor.spaceId,
        threadId: bot.thread!.id,
        botId: bot.id,
        data: { memoryScope: "isolated" },
        emitBotUpdated: false,
        beforeWrite: async (tx) => {
          await assertMemoryScopeSupported(tx, actor.spaceId, "isolated");
          locked.open();
          await release.promise;
        },
      });
      operations.push(update);
      await locked.promise;
      const connect = persistMemoryProviderConfig(deps(prisma), actor, input(actor));
      const rejected = expect(connect).rejects.toMatchObject({ code: "BAD_REQUEST" });
      operations.push(connect);
      await waitForScopeWaiter(prisma, actor.spaceId);
      release.open();
      await update;
      await rejected;
      expect(
        await prisma.spaceMemoryConfig.findUnique({ where: { spaceId: actor.spaceId } }),
      ).toBeNull();
      expect(await prisma.bot.findUnique({ where: { id: bot.id } })).toMatchObject({
        memoryScope: "isolated",
      });
      await commitBotUpdate({
        prisma,
        notify: async () => {},
        spaceId: actor.spaceId,
        threadId: bot.thread!.id,
        botId: bot.id,
        data: { memoryScope: "shared" },
        emitBotUpdated: false,
      });
      await expect(
        persistMemoryProviderConfig(deps(prisma), actor, input(actor)),
      ).resolves.toMatchObject({ provider: "rembric", capabilities: { isolatedScope: false } });
    } finally {
      release.open();
      await Promise.allSettled(operations);
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  },
  15000,
);

it.skipIf(!databaseUrl)(
  "refuses an archived other member's isolated bot without rewriting it",
  async () => {
    const db = createDb(databaseUrl!);
    const prisma = asSystem(db.prisma);
    try {
      const { actor } = await fixture(prisma);
      const other = await fixture(prisma);
      const { organizationId } = await prisma.space.findUniqueOrThrow({
        where: { id: actor.spaceId },
        select: { organizationId: true },
      });
      await prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId,
          userId: other.actor.userId,
          role: "member",
          createdAt: new Date(),
        },
      });
      // The member_default_space_membership trigger enrolls the member in this default Space.
      expect(
        await prisma.spaceMember.findUnique({
          where: { spaceId_userId: { spaceId: actor.spaceId, userId: other.actor.userId } },
        }),
      ).toMatchObject({ role: "member" });
      const bot = await prisma.bot.create({
        data: {
          spaceId: actor.spaceId,
          userId: other.actor.userId,
          name: "Archived",
          color: "ink",
          memoryScope: "isolated",
          archivedAt: new Date(),
        },
      });
      await expect(
        runAsTenant(actor, () => persistMemoryProviderConfig(deps(db.prisma), actor, input(actor))),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(await prisma.bot.findUnique({ where: { id: bot.id } })).toMatchObject({
        memoryScope: "isolated",
        archivedAt: expect.any(Date),
      });
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  },
  15000,
);
