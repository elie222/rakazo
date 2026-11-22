import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../database/client.js";
import { createDb } from "../database/client.js";
import { asSystem, runAsTenant } from "../database/row-security.js";
import {
  grantComputerAllowance,
  sandboxAllowancePlan,
  sandboxRunHours,
  sandboxRunHoursByComputer,
  speechAllowancePlan,
} from "./sandbox-allowance.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("computer allowance hours (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `allowance-organization-${suffix}`;
  const otherOrganizationId = `allowance-other-${suffix}`;
  const spaceId = `allowance-space-${suffix}`;
  const otherSpaceId = `allowance-other-space-${suffix}`;
  const since = new Date("2026-03-01T00:00:00.000Z");
  const now = new Date("2026-03-10T00:00:00.000Z");
  let db: PrismaClient;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const created = createDb(databaseUrl!);
    db = created.prisma;
    prisma = asSystem(db);
    close = async () => {
      await created.prisma.$disconnect();
      await created.pool.end();
    };
    for (const [id, space] of [
      [organizationId, spaceId],
      [otherOrganizationId, otherSpaceId],
    ] as const) {
      await prisma.organization.create({
        data: { id, name: id, slug: id, createdAt: new Date() },
      });
      await prisma.space.create({ data: { id: space, organizationId: id, name: "General" } });
    }
    const run = (
      computerId: string,
      kind: string,
      startedAt: string,
      endedAt: string | null,
      space = spaceId,
    ) => ({
      computerId: `${computerId}-${suffix}`,
      spaceId: space,
      kind,
      startedAt: new Date(startedAt),
      endedAt: endedAt ? new Date(endedAt) : null,
    });
    await prisma.computerRun.createMany({
      data: [
        // Started last month: only the hour after the month began counts.
        run("a", "boat", "2026-02-28T22:00:00.000Z", "2026-03-01T01:00:00.000Z"),
        {
          ...run("a", "boat", "2026-03-02T00:00:00.000Z", "2026-03-02T02:00:00.000Z"),
          size: "standard",
        },
        // Still running: counts up to now.
        run("b", "e2b", "2026-03-09T20:00:00.000Z", null),
        // Ended before the month.
        run("c", "boat", "2026-02-10T00:00:00.000Z", "2026-02-10T05:00:00.000Z"),
        run("d", "boat", "2026-03-02T00:00:00.000Z", "2026-03-02T09:00:00.000Z", otherSpaceId),
      ],
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.computerRun.deleteMany({ where: { spaceId: { in: [spaceId, otherSpaceId] } } });
    await prisma.organization.deleteMany({
      where: { id: { in: [organizationId, otherOrganizationId] } },
    });
    await close();
  });

  it("sums this period's hours by kind, clipping runs to the period and counting open runs", async () => {
    // From a tenant's request, so it must still see the organization's other Spaces.
    const hours = await runAsTenant({ spaceId: otherSpaceId, userId: "user" }, () =>
      sandboxRunHours(db, organizationId, since, now),
    );
    expect(hours).toHaveLength(3);
    expect(hours).toEqual(
      expect.arrayContaining([
        { kind: "boat", size: null, hours: 1 },
        { kind: "boat", size: "standard", hours: 2 },
        { kind: "e2b", size: null, hours: 4 },
      ]),
    );
    const byComputer = await runAsTenant({ spaceId: spaceId, userId: "user" }, () =>
      sandboxRunHoursByComputer(db, organizationId, since, now),
    );
    expect(byComputer).toEqual(
      expect.arrayContaining([
        { computerId: `a-${suffix}`, kind: "boat", size: null, hours: 1 },
        { computerId: `a-${suffix}`, kind: "boat", size: "standard", hours: 2 },
        { computerId: `b-${suffix}`, kind: "e2b", size: null, hours: 4 },
      ]),
    );
    expect(byComputer).toHaveLength(3);
  });

  it("adds a grant to the period it was made in and not to the next one", async () => {
    const periodStart = new Date("2026-03-05T00:00:00.000Z");
    const settings = await prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { modelCreditsEnabled: true },
    });
    await prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", modelCreditsEnabled: true },
      update: { modelCreditsEnabled: true },
    });
    await prisma.billingAccount.create({
      data: {
        organizationId,
        customerId: `customer-${suffix}`,
        status: "active",
        byokTier: "pro",
        byokPriceCents: 4_000,
        byokInterval: "month",
        currentPeriodStartsAt: periodStart,
        currentPeriodEndsAt: new Date("2026-04-05T00:00:00.000Z"),
      },
    });
    try {
      expect(await sandboxAllowancePlan(prisma, organizationId, now)).toMatchObject({
        limitCents: 2_000,
        extraCents: 0,
      });
      // Speech gets a fifth of the tier's list price, renewing with the same period.
      expect(await speechAllowancePlan(prisma, organizationId, now)).toEqual({
        limitMicros: 9_800_000n,
        since: periodStart,
      });
      await grantComputerAllowance(prisma, organizationId, 2_500);
      const grant = await prisma.computerAllowanceGrant.findFirstOrThrow({
        where: { organizationId },
      });
      // Granted during this period.
      await prisma.computerAllowanceGrant.update({
        where: { id: grant.id },
        data: { createdAt: new Date("2026-03-09T00:00:00.000Z") },
      });
      const during = await sandboxAllowancePlan(prisma, organizationId, now);
      expect(during).toMatchObject({ limitCents: 4_500, extraCents: 2_500 });
      expect(
        await prisma.billingAuditEvent.findUnique({
          where: { source: `computer-allowance:${grant.id}` },
          select: { kind: true, organizationId: true, amountMicros: true },
        }),
      ).toEqual({ kind: "computer_allowance_granted", organizationId, amountMicros: 0n });

      await prisma.billingAccount.update({
        where: { organizationId },
        data: {
          currentPeriodStartsAt: new Date("2026-04-05T00:00:00.000Z"),
          currentPeriodEndsAt: new Date("2026-05-05T00:00:00.000Z"),
        },
      });
      const next = await sandboxAllowancePlan(
        prisma,
        organizationId,
        new Date("2026-04-10T00:00:00.000Z"),
      );
      expect(next).toMatchObject({ limitCents: 2_000, extraCents: 0 });

      // An operator can still give a cancelled trial hours; the period renews nothing for it.
      await prisma.billingAccount.update({
        where: { organizationId },
        data: {
          status: "trialing",
          cancelAtPeriodEnd: true,
          currentPeriodStartsAt: new Date("2026-06-01T00:00:00.000Z"),
          currentPeriodEndsAt: new Date("2026-06-15T00:00:00.000Z"),
        },
      });
      await prisma.computerAllowanceGrant.create({
        data: { organizationId, amountCents: 1_000, createdAt: new Date("2026-06-03T00:00:00Z") },
      });
      expect(
        await sandboxAllowancePlan(prisma, organizationId, new Date("2026-06-05T00:00:00Z")),
      ).toMatchObject({ limitCents: 1_000, extraCents: 1_000, resetsAt: null });

      // Once the plan lapses into granted credit, grants from its paid periods stay spent.
      await prisma.billingAccount.update({
        where: { organizationId },
        data: {
          status: "canceled",
          cancelAtPeriodEnd: false,
          byokTier: null,
          byokPriceCents: null,
          creditAmountCents: null,
          currentPeriodStartsAt: new Date("2026-07-01T00:00:00.000Z"),
          currentPeriodEndsAt: new Date("2026-08-01T00:00:00.000Z"),
        },
      });
      await prisma.accessGrant.create({
        data: {
          email: `pool-${organizationId}@rakazo.test`,
          organizationId,
          creditCents: 5_000,
          appliedAt: new Date("2026-01-01T00:00:00Z"),
        },
      });
      await prisma.computerAllowanceGrant.create({
        data: { organizationId, amountCents: 300, createdAt: new Date("2026-08-02T00:00:00Z") },
      });
      expect(
        await sandboxAllowancePlan(prisma, organizationId, new Date("2026-08-05T00:00:00Z")),
      ).toMatchObject({ limitCents: 1_000 + 300, extraCents: 300 });

      // A plan that stopped mid-period still has a future end; a grant after it stopped counts.
      await prisma.billingAccount.update({
        where: { organizationId },
        data: {
          currentPeriodStartsAt: new Date("2026-08-01T00:00:00.000Z"),
          currentPeriodEndsAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      });
      await prisma.computerAllowanceGrant.create({
        data: { organizationId, amountCents: 200, createdAt: new Date("2026-08-10T00:00:00Z") },
      });
      expect(
        await sandboxAllowancePlan(prisma, organizationId, new Date("2026-08-12T00:00:00Z")),
      ).toMatchObject({ limitCents: 1_000 + 500, extraCents: 500 });

      // A lapsed yearly plan renewed monthly, so only grants from its last month still count.
      await prisma.billingAccount.update({
        where: { organizationId },
        data: {
          byokInterval: "year",
          currentPeriodStartsAt: new Date("2026-01-20T00:00:00.000Z"),
          currentPeriodEndsAt: new Date("2027-01-20T00:00:00.000Z"),
        },
      });
      expect(
        await sandboxAllowancePlan(prisma, organizationId, new Date("2026-08-25T00:00:00Z")),
      ).toMatchObject({ limitCents: 1_000, extraCents: 0 });
    } finally {
      await prisma.billingAccount.deleteMany({ where: { organizationId } });
      await prisma.accessGrant.deleteMany({ where: { organizationId } });
      if (settings)
        await prisma.deploymentSettings.update({ where: { id: "default" }, data: settings });
      else await prisma.deploymentSettings.delete({ where: { id: "default" } });
    }
  });
});
