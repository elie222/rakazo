import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { changeUserTimezone } from "./schedule-tools.js";

// Needs DATABASE_URL as the runtime login and DATABASE_MIGRATION_URL as the owner,
// as `pnpm test:integration` provides.
const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe.sequential
    : describe.skip;

describePostgres("moving routines with the account timezone (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `tz-move-org-${suffix}`;
  const userId = `tz-move-user-${suffix}`;
  const otherUserId = `tz-move-other-${suffix}`;
  const spaces = ["a", "b"].map((name) => ({
    name,
    spaceId: `tz-move-space-${name}-${suffix}`,
    botId: `tz-move-bot-${name}-${suffix}`,
  }));
  let owner: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let app: ReturnType<typeof createDb>;
  const jobs = {
    enqueue: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };

  beforeAll(() => runAsSystem("test fixture", seed));

  async function seed() {
    owner = createDb(migrationUrl!);
    system = asSystem(owner.prisma);
    app = createDb(runtimeUrl!, { poolMax: 6 });
    const o = owner.prisma;
    await o.organization.create({
      data: { id: organizationId, name: "Tz", slug: organizationId, createdAt: new Date() },
    });
    for (const id of [userId, otherUserId]) {
      await o.user.create({
        data: {
          id,
          name: id,
          email: `${id}@rakazo.test`,
          emailVerified: true,
          timezone: "Africa/Cairo",
        },
      });
    }
    for (const space of spaces) {
      await o.space.create({ data: { id: space.spaceId, organizationId, name: space.name } });
      await o.bot.create({
        data: { id: space.botId, spaceId: space.spaceId, userId, name: space.name, color: "#000" },
      });
    }
  }

  afterAll(async () => {
    if (!owner) return;
    await system.organization.deleteMany({ where: { id: organizationId } });
    await system.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    for (const handle of [owner, app]) {
      await handle.prisma.$disconnect();
      await handle.pool.end();
    }
  });

  /** One active weekly routine at Monday 09:00 Africa/Cairo in the given space. */
  async function weeklyRoutine(space: (typeof spaces)[number], rowUserId: string, name: string) {
    return system.routine.create({
      data: {
        spaceId: space.spaceId,
        botId: space.botId,
        userId: rowUserId,
        name,
        prompt: "fixture",
        crons: ["0 9 * * 1"],
        timezone: "Africa/Cairo",
        notify: true,
        active: true,
        // A far-future Monday 09:00 Cairo, so no fixture depends on the wall clock.
        nextRunAt: new Date("2026-11-09T07:00:00.000Z"),
      },
    });
  }

  async function resetAccount() {
    await system.routine.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await system.user.update({ where: { id: userId }, data: { timezone: "Africa/Cairo" } });
  }

  it("moves the user's routines in every space, and only theirs", async () => {
    await resetAccount();
    const mine = [
      await weeklyRoutine(spaces[0]!, userId, "A"),
      await weeklyRoutine(spaces[1]!, userId, "B"),
    ];
    const foreign = await weeklyRoutine(spaces[0]!, otherUserId, "Other");

    // The save arrives while the user works in one space; the other space's routines
    // are invisible in that tenant scope.
    await runAsTenant({ spaceId: spaces[0]!.spaceId, userId }, () =>
      changeUserTimezone({ prisma: app.prisma, jobs }, userId, "Europe/London"),
    );

    const rows = await system.routine.findMany({
      where: { id: { in: [...mine.map((routine) => routine.id), foreign.id] } },
    });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.timezone).toBe(row.userId === userId ? "Europe/London" : "Africa/Cairo");
    }
    for (const created of mine) {
      const row = rows.find((candidate) => candidate.id === created.id);
      expect(row?.nextRunAt?.toISOString()).toBe("2026-11-09T09:00:00.000Z");
    }
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "routine.wakeup",
        payload: expect.objectContaining({ routineId: mine[0]!.id }),
      }),
    );
    await expect(
      system.user.findUniqueOrThrow({ where: { id: userId }, select: { timezone: true } }),
    ).resolves.toEqual({ timezone: "Europe/London" });
  });

  it("keeps every routine on the account's zone when two saves overlap", async () => {
    await resetAccount();
    await weeklyRoutine(spaces[0]!, userId, "A");
    await weeklyRoutine(spaces[1]!, userId, "B");

    // Both saves start before either commits: the one that loses the user-row lock
    // still sees the winner's zone as the previous one.
    const first = runAsTenant({ spaceId: spaces[0]!.spaceId, userId }, () =>
      changeUserTimezone({ prisma: app.prisma, jobs }, userId, "Europe/London"),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = runAsTenant({ spaceId: spaces[1]!.spaceId, userId }, () =>
      changeUserTimezone({ prisma: app.prisma, jobs }, userId, "Asia/Tokyo"),
    );
    await Promise.all([first, second]);

    const user = await system.user.findUniqueOrThrow({
      where: { id: userId },
      select: { timezone: true },
    });
    expect(["Europe/London", "Asia/Tokyo"]).toContain(user.timezone);
    const routines = await system.routine.findMany({ where: { userId } });
    expect(routines).toHaveLength(2);
    for (const routine of routines) {
      expect(routine.timezone).toBe(user.timezone);
    }
  });

  it("moves a routine a run claims while the save is in flight", async () => {
    await resetAccount();
    const routine = await weeklyRoutine(spaces[0]!, userId, "A");

    // A wakeup claim holds the routine row and advances its pending occurrence while
    // the zone save is between its read and its write. The claim runs as the job
    // system would, on the runtime login.
    const claimed = new Date("2026-11-16T07:00:00.000Z"); // next Monday 09:00 Cairo
    await runAsSystem("routine claim fixture", async () => {
      const client = await app.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM routines WHERE id = $1 FOR UPDATE", [routine.id]);
        const moving = runAsTenant({ spaceId: spaces[0]!.spaceId, userId }, () =>
          changeUserTimezone({ prisma: app.prisma, jobs }, userId, "Europe/London"),
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
        await client.query('UPDATE routines SET "nextRunAt" = $2 WHERE id = $1', [
          routine.id,
          claimed,
        ]);
        await client.query("COMMIT");
        await moving;
      } finally {
        client.release();
      }
    });

    const row = await system.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(row.timezone).toBe("Europe/London");
    // The claimed occurrence's local time holds: Monday 09:00 London.
    expect(row.nextRunAt?.toISOString()).toBe("2026-11-16T09:00:00.000Z");
  });
});
