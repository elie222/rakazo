import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commitBotUpdate } from "./bot-update.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { runAsSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

/** One deadline for every poll of a barrier, inside the transactions' 20s budget. */
const BARRIER_POLL_BUDGET_MS = 4_000;

/** The fixture rows one restyle addresses. */
type Fixture = { spaceId: string; userId: string; threadId: string; botId: string };

/**
 * A restyle of one unpinned bot, as the account route issues it: the same
 * expectation the route passes, inside the bot's space.
 */
function restyle(prisma: PrismaClient, botAvatarSet: string, ids: Fixture) {
  return runAsTenant({ spaceId: ids.spaceId, userId: ids.userId }, () =>
    commitBotUpdate({
      prisma,
      notify: async () => undefined,
      spaceId: ids.spaceId,
      threadId: ids.threadId,
      botId: ids.botId,
      emitBotUpdated: true,
      expectedSettings: { avatarSetPinned: false },
      expectedUserAvatarSet: { userId: ids.userId, botAvatarSet },
      data: { avatarSet: botAvatarSet },
    }),
  );
}

describePostgres("commitBotUpdate against a moving default avatar set (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const ids: Fixture & { organizationId: string } = {
    organizationId: `bot-style-org-${suffix}`,
    spaceId: `bot-style-space-${suffix}`,
    userId: `bot-style-user-${suffix}`,
    threadId: `bot-style-thread-${suffix}`,
    botId: `bot-style-bot-${suffix}`,
  };
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    await runAsSystem("test fixture", async () => {
      await prisma.organization.create({
        data: {
          id: ids.organizationId,
          name: "Style",
          slug: ids.organizationId,
          createdAt: new Date(),
        },
      });
      await prisma.space.create({
        data: { id: ids.spaceId, organizationId: ids.organizationId, name: "General" },
      });
      await prisma.user.create({
        data: {
          id: ids.userId,
          name: ids.userId,
          email: `${ids.userId}@rakazo.test`,
          emailVerified: false,
          botAvatarSet: "organic",
        },
      });
      await prisma.bot.create({
        data: {
          id: ids.botId,
          spaceId: ids.spaceId,
          userId: ids.userId,
          name: "Chief",
          color: "#000",
          avatarSet: "organic",
          avatarSetPinned: false,
        },
      });
      await prisma.thread.create({
        data: { id: ids.threadId, spaceId: ids.spaceId, userId: ids.userId, botId: ids.botId },
      });
    });
  });

  afterAll(async () => {
    if (!db) return;
    await runAsSystem("test cleanup", async () => {
      await prisma.organization.deleteMany({ where: { id: ids.organizationId } });
      await prisma.user.deleteMany({ where: { id: ids.userId } });
    });
    await prisma.$disconnect();
    await db.pool.end();
  });

  /**
   * Wait until PostgreSQL itself shows a session blocked on a lock `holder` holds, so a
   * barrier step proves SQL progress instead of assuming it from elapsed time. Returns
   * the blocked backend's pid; all polls of one barrier share its deadline.
   */
  async function waitForBlockedOn(holder: number, what: string, deadline: number): Promise<number> {
    const monitor = await db.pool.connect();
    try {
      while (performance.now() < deadline) {
        const { rows } = await monitor.query(
          "SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pg_blocking_pids(pid) @> ARRAY[$1::int]",
          [holder],
        );
        if (rows.length > 0) return rows[0]!.pid;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`timed out waiting for ${what} to block on backend ${holder}`);
    } finally {
      monitor.release();
    }
  }

  /** An operation set whose failures are handled at once and drained at cleanup. */
  function started() {
    const ops: Array<Promise<unknown>> = [];
    return {
      track: (op: Promise<unknown>) => {
        ops.push(
          op.then(
            () => undefined,
            () => undefined,
          ),
        );
        return op;
      },
      settle: () => Promise.allSettled(ops),
    };
  }

  /**
   * The runtime client with its interactive transactions given twenty seconds, so a
   * restyle sitting at a barrier cannot be expired by Prisma's five-second default.
   */
  const unhurried = () =>
    new Proxy(prisma, {
      get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key);
        const transaction = Reflect.get(target, "$transaction").bind(target) as (
          work: unknown,
          options?: Record<string, unknown>,
        ) => unknown;
        return (work: unknown, options?: Record<string, unknown>) =>
          transaction(work, { timeout: 20_000, ...options });
      },
    }) as PrismaClient;

  const rows = () =>
    runAsSystem("test assertion", async () => ({
      user: await prisma.user.findUniqueOrThrow({
        where: { id: ids.userId },
        select: { botAvatarSet: true },
      }),
      bot: await prisma.bot.findUniqueOrThrow({
        where: { id: ids.botId },
        select: { avatarSet: true, avatarSetPinned: true },
      }),
    }));

  it("leaves the bot on the newest default when a newer save lands while the restyle waits on the thread lock", async () => {
    const ops = started();
    const holder = await db.pool.connect();
    try {
      // Request A saves the default rakazo, then its restyle waits on the thread lock.
      await runAsSystem("test fixture", () =>
        prisma.user.update({ where: { id: ids.userId }, data: { botAvatarSet: "rakazo" } }),
      );
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM threads WHERE id = $1 FOR UPDATE", [ids.threadId]);
      const { rows: own } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const deadline = performance.now() + BARRIER_POLL_BUDGET_MS;
      const update = ops.track(restyle(unhurried(), "rakazo", ids));
      await waitForBlockedOn(own[0]!.pid, "the restyle", deadline);
      // Request B saves the default organic and finishes while A waits: the bot still
      // has organic, so B's own pass lists nothing. The older restyle must not win.
      await runAsSystem("test fixture", () =>
        prisma.user.update({ where: { id: ids.userId }, data: { botAvatarSet: "organic" } }),
      );
      await holder.query("COMMIT");
      await expect(update).resolves.toBeNull();
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      await ops.settle();
    }

    const state = await rows();
    expect(state.user.botAvatarSet).toBe("organic");
    expect(state.bot).toMatchObject({ avatarSet: "organic", avatarSetPinned: false });
  });

  it("holds off a newer save of the default until the restyle's bot write commits", async () => {
    const ops = started();
    const holder = await db.pool.connect();
    try {
      await runAsSystem("test fixture", () =>
        prisma.user.update({ where: { id: ids.userId }, data: { botAvatarSet: "rakazo" } }),
      );
      // The bot row is held, so the restyle sits between its FOR SHARE read of the
      // default and its bot write, provably past the read.
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM bots WHERE id = $1 FOR UPDATE", [ids.botId]);
      const { rows: own } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const deadline = performance.now() + BARRIER_POLL_BUDGET_MS;
      const update = ops.track(restyle(unhurried(), "rakazo", ids));
      const updatePid = await waitForBlockedOn(own[0]!.pid, "the restyle", deadline);
      const newer = ops.track(
        runAsSystem("test fixture", () =>
          prisma.user.update({ where: { id: ids.userId }, data: { botAvatarSet: "organic" } }),
        ),
      );
      // The newer save waits on the restyle's share of the user row instead of
      // slipping between its read and its write.
      await waitForBlockedOn(updatePid, "the newer save of the default", deadline);
      await holder.query("COMMIT");
      await update;
      await newer;
      // The newer pass lists the bot (now rakazo) and styles it to its own default.
      await restyle(prisma, "organic", ids);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      await ops.settle();
    }

    const state = await rows();
    expect(state.user.botAvatarSet).toBe("organic");
    expect(state.bot.avatarSet).toBe("organic");
  });
});
