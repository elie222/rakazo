import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireComputerExecutionLease,
  holdComputerExecutionLeaseForTakeover,
  releaseComputerExecutionLease,
  renewComputerExecutionLease,
} from "./computer-lifecycle.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("explicit profile shared-checkout leases (PostgreSQL)", () => {
  const suffix = randomUUID();
  const organizationId = `lease-org-${suffix}`;
  const spaceId = `lease-space-${suffix}`;
  const userId = `lease-user-${suffix}`;
  let computerId: string;
  let prisma: PrismaClient;
  let pool: Pool;

  beforeAll(async () => {
    ({ prisma, pool } = createDb(databaseUrl!, { poolMax: 5 }));
    await prisma.user.create({
      data: { id: userId, name: "Lease Test", email: `${userId}@example.test` },
    });
    await prisma.organization.create({
      data: { id: organizationId, name: "Lease Test", slug: organizationId, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId, name: "Lease Test" } });
  });
  beforeEach(async () => {
    computerId = `lease-computer-${randomUUID()}`;
    await prisma.computer.create({
      data: {
        id: computerId,
        spaceId,
        userId,
        scope: "team",
        scopeKey: computerId,
        homeKey: computerId,
        kind: "fake",
        state: "running",
      },
    });
  });
  afterEach(async () => {
    if (prisma && computerId) await prisma.computer.deleteMany({ where: { id: computerId } });
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
    await pool.end();
  });
  const claim = (botId: string, exclusive = false, resumeHeldLease = false) =>
    acquireComputerExecutionLease(prisma, {
      computerId,
      botId,
      runId: `run-${botId}`,
      exclusive,
      resumeHeldLease,
    });

  it.each([false, true])(
    "rejects a competing acquisition when first exclusive=%s, then permits expired reclaim",
    async (exclusive) => {
      const first = await claim("first", exclusive);
      await expect(claim("second", !exclusive)).rejects.toThrow("Computer is busy");
      await releaseComputerExecutionLease(prisma, first);
      const second = await claim("second", !exclusive);
      expect(second).not.toBeNull();
      await releaseComputerExecutionLease(prisma, second);
      const reclaimed = await claim("first", exclusive);
      expect(reclaimed?.fence).toBe(2);
    },
  );

  it("keeps two legacy Pi bots concurrent", async () => {
    const results = await Promise.all([claim("first"), claim("second")]);
    expect(results.every(Boolean)).toBe(true);
  });

  it("retains exclusivity across renewal and takeover, without resurrecting an expired lease", async () => {
    const first = await claim("first", true);
    expect(await renewComputerExecutionLease(prisma, first)).toBe(true);
    expect(await holdComputerExecutionLeaseForTakeover(prisma, first)).toBe(true);
    await expect(claim("second")).rejects.toThrow("Computer is busy");
    const resumed = await claim("first", true, true);
    expect(resumed?.fence).toBe(2);
    expect(await renewComputerExecutionLease(prisma, first)).toBe(false);
    await releaseComputerExecutionLease(prisma, resumed);
    expect(await holdComputerExecutionLeaseForTakeover(prisma, resumed)).toBe(false);
    expect(await claim("second")).not.toBeNull();
  });

  it.each([
    [true, "insert"],
    [false, "insert"],
    [true, "reclaim"],
    [false, "reclaim"],
  ] as const)(
    "sees the winning transaction after waiting: first exclusive=%s, competitor=%s",
    async (exclusive, operation) => {
      if (operation === "reclaim")
        await prisma.computerExecutionLease.create({
          data: {
            computerId,
            botId: "second",
            runId: "old-run",
            expiresAt: new Date(0),
            exclusive: !exclusive,
          },
        });
      const first = await pool.connect();
      const second = await pool.connect();
      try {
        await first.query("BEGIN");
        const firstPid = (await first.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]!.pid;
        const secondPid = (await second.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]!.pid;
        const insert = `INSERT INTO computer_execution_leases (id, "computerId", "botId", "runId", "expiresAt", "exclusive", "updatedAt") VALUES ($1, $2, $3, $4, timezone('UTC', clock_timestamp()) + interval '1 minute', $5, now())`;
        await first.query(insert, [randomUUID(), computerId, "first", "run-first", exclusive]);
        const contender =
          operation === "insert"
            ? second.query(insert, [randomUUID(), computerId, "second", "run-second", !exclusive])
            : second.query(
                `UPDATE computer_execution_leases SET "expiresAt" = timezone('UTC', clock_timestamp()) + interval '1 minute', "fence" = "fence" + 1 WHERE "computerId" = $1 AND "botId" = 'second'`,
                [computerId],
              );
        const rejected = expect(contender).rejects.toMatchObject({
          code: "23505",
          constraint: "computer_execution_lease_exclusive",
        });
        await vi.waitFor(
          async () => {
            const result = await first.query<{ blockers: number[] }>(
              "SELECT pg_blocking_pids($1) AS blockers",
              [secondPid],
            );
            expect(result.rows[0]!.blockers).toContain(firstPid);
          },
          { timeout: 5_000, interval: 10 },
        );
        await first.query("COMMIT");
        await rejected;
        expect(
          await prisma.computerExecutionLease.count({
            where: { computerId, expiresAt: { gt: new Date() } },
          }),
        ).toBe(1);
      } finally {
        await first.query("ROLLBACK");
        first.release();
        second.release();
      }
    },
  );
});
