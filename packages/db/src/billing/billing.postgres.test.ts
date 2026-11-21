import type { BillingSubscriptionSnapshot } from "@rakazo/adapter-kit";
import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../database/client.js";
import { createDb } from "../database/client.js";
import {
  billingAccountForOrganization,
  createBillingAccount,
  memberHasModelAccess,
  organizationForMember,
  organizationSeatCount,
  ownedBillingAccounts,
  syncBillingSnapshot,
} from "./billing.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

const snapshot: BillingSubscriptionSnapshot = {
  subscriptionId: "sub_1",
  subscriptionItemId: "si_1",
  priceId: "price_1",
  status: "trialing",
  seats: 2,
  trialEndsAt: new Date("2026-10-14T00:00:00.000Z"),
  currentPeriodStartsAt: new Date("2026-10-07T00:00:00.000Z"),
  currentPeriodEndsAt: new Date("2026-10-14T00:00:00.000Z"),
  cancelAtPeriodEnd: false,
  endedAt: null,
};

describePostgres("billing accounts (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const ownerId = `billing-owner-${suffix}`;
  const memberId = `billing-member-${suffix}`;
  const organizationId = `billing-organization-${suffix}`;
  const spaceId = `billing-space-${suffix}`;
  const customerId = `cus_${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    const createdAt = new Date();
    for (const id of [ownerId, memberId]) {
      await prisma.user.create({
        data: { id, name: id, email: `${id}@rakazo.test`, emailVerified: false },
      });
    }
    await prisma.organization.create({
      data: { id: organizationId, name: "Billing Org", slug: organizationId, createdAt },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
    await prisma.member.createMany({
      data: [
        { id: `m-${ownerId}`, organizationId, userId: ownerId, role: "admin, owner", createdAt },
        { id: `m-${memberId}`, organizationId, userId: memberId, role: "member", createdAt },
      ],
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId] } } });
    await close();
  });

  it("reads model access from a whole run row, not just its key", async () => {
    const run = { id: "run-1", spaceId, userId: memberId, botId: "bot-1" };
    await expect(memberHasModelAccess(prisma, run)).resolves.toBe(false);
  });

  it("detects the organization owner from comma-separated roles", async () => {
    await expect(organizationForMember(prisma, { spaceId, userId: ownerId })).resolves.toEqual({
      organizationId,
      isOwner: true,
    });
    await expect(organizationForMember(prisma, { spaceId, userId: memberId })).resolves.toEqual({
      organizationId,
      isOwner: false,
    });
    await expect(organizationSeatCount(prisma, organizationId)).resolves.toBe(2);
  });

  it("keeps the first customer when an account is created twice", async () => {
    await createBillingAccount(prisma, { organizationId, customerId });
    const again = await createBillingAccount(prisma, {
      organizationId,
      customerId: `${customerId}-dup`,
    });
    expect(again.customerId).toBe(customerId);
    await expect(ownedBillingAccounts(prisma, ownerId)).resolves.toMatchObject([{ customerId }]);
    await expect(ownedBillingAccounts(prisma, memberId)).resolves.toEqual([]);
  });

  it("overwrites the snapshot idempotently and records the first subscription and payment once", async () => {
    await expect(syncBillingSnapshot(prisma, "cus_unknown", async () => snapshot)).resolves.toBe(
      false,
    );

    await expect(syncBillingSnapshot(prisma, customerId, async () => snapshot)).resolves.toBe(true);
    const first = await billingAccountForOrganization(prisma, organizationId);
    expect(first).toMatchObject({ status: "trialing", seats: 2, subscriptionItemId: "si_1" });
    expect(first?.subscribedAt).toBeInstanceOf(Date);
    expect(first?.paidAt).toBeNull();

    // Active comes before the trial's charge is collected, so it is not yet a payment.
    await syncBillingSnapshot(prisma, customerId, async () => ({ ...snapshot, status: "active" }));
    const unpaid = await billingAccountForOrganization(prisma, organizationId);
    expect(unpaid).toMatchObject({ status: "active", paidAt: null });

    const paidAt = new Date("2026-01-02T03:04:05Z");
    await syncBillingSnapshot(prisma, customerId, async () => ({
      ...snapshot,
      status: "active",
      paidAt,
    }));
    const second = await billingAccountForOrganization(prisma, organizationId);
    expect(second?.subscribedAt).toEqual(first?.subscribedAt);
    expect(second?.paidAt).toEqual(paidAt);

    await syncBillingSnapshot(prisma, customerId, async () => null);
    const cleared = await billingAccountForOrganization(prisma, organizationId);
    expect(cleared).toMatchObject({
      subscriptionId: null,
      subscriptionItemId: null,
      status: null,
      seats: null,
      trialEndsAt: null,
      cancelAtPeriodEnd: false,
    });
    expect(cleared?.subscribedAt).toEqual(first?.subscribedAt);
    expect(cleared?.paidAt).toEqual(second?.paidAt);
  });

  it("applies concurrent syncs in order so an older read cannot win", async () => {
    let olderRead!: Deferred;
    const loaded = deferred();
    const older = syncBillingSnapshot(prisma, customerId, async () => {
      loaded.resolve();
      olderRead = deferred();
      await olderRead.promise;
      return { ...snapshot, status: "trialing" };
    });
    await loaded.promise;
    const newer = syncBillingSnapshot(prisma, customerId, async () => ({
      ...snapshot,
      status: "active",
    }));
    // The newer sync writes first; the older one, which started earlier, must not land on top.
    await new Promise((resolve) => setTimeout(resolve, 200));
    olderRead.resolve();
    await Promise.all([older, newer]);
    await expect(billingAccountForOrganization(prisma, organizationId)).resolves.toMatchObject({
      status: "active",
    });
  });

  it("deletes the account with its organization", async () => {
    await prisma.organization.delete({ where: { id: organizationId } });
    await expect(prisma.billingAccount.count({ where: { customerId } })).resolves.toBe(0);
  });
});
