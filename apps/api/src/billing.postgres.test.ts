import { BillingEmulator } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { billingAccountForOrganization, createBillingAccount, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BILLING_RETURN_PATH, createBillingService, TRIAL_DAYS } from "./billing.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("billing service (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const ownerId = `billing-svc-owner-${suffix}`;
  const memberId = `billing-svc-member-${suffix}`;
  const organizationId = `billing-svc-organization-${suffix}`;
  const spaceId = `billing-svc-space-${suffix}`;
  const webOrigin = "https://app.example.com";
  const owner: Actor = {
    userId: ownerId,
    spaceId,
    email: `${ownerId}@rakazo.test`,
    isDeploymentOwner: false,
  };
  const member: Actor = { ...owner, userId: memberId, email: `${memberId}@rakazo.test` };
  const emulator = new BillingEmulator();
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let billing: ReturnType<typeof createBillingService>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    billing = createBillingService({ prisma, provider: emulator, webOrigin });
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
    await prisma.member.create({
      data: { id: `m-${ownerId}`, organizationId, userId: ownerId, role: "owner", createdAt },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId] } } });
    await close();
  });

  it("offers a trial before the organization has subscribed", async () => {
    await expect(billing.status(owner)).resolves.toEqual({
      access: false,
      canManage: true,
      trialAvailable: true,
      trialDays: TRIAL_DAYS,
      state: "none",
      price: emulator.price,
      seats: 1,
      trialEndsAt: null,
      currentPeriodEndsAt: null,
      cancelAtPeriodEnd: false,
      hasCustomer: false,
    });
  });

  it("requires a subscription for admins too", async () => {
    await expect(billing.status({ ...owner, isDeploymentOwner: true })).resolves.toMatchObject({
      access: false,
    });
  });

  it("creates the customer before checkout and syncs the completed subscription", async () => {
    const { url } = await billing.checkout(owner);
    expect(url).toContain("checkout");
    const account = await billingAccountForOrganization(prisma, organizationId);
    expect(account).not.toBeNull();
    const customerId = account!.customerId;
    expect(emulator.checkouts.get(customerId)).toEqual({
      customerId,
      seats: 1,
      trialDays: TRIAL_DAYS,
      successUrl: `${webOrigin}${BILLING_RETURN_PATH}`,
      cancelUrl: `${webOrigin}/app`,
    });

    emulator.completeCheckout(customerId);
    await billing.syncForActor(owner);
    await expect(billing.status(owner)).resolves.toMatchObject({
      access: true,
      state: "trialing",
      trialAvailable: false,
      hasCustomer: true,
      seats: 1,
    });
    await expect(billing.checkout(owner)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(billing.portal(owner)).resolves.toMatchObject({
      url: expect.stringContaining("portal"),
    });
  });

  it("only lets owners manage billing", async () => {
    await prisma.member.create({
      data: {
        id: `m-${memberId}`,
        organizationId,
        userId: memberId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await expect(billing.status(member)).resolves.toMatchObject({
      access: true,
      canManage: false,
    });
    await expect(billing.checkout(member)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(billing.portal(member)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("pushes member count changes to the subscription", async () => {
    await billing.syncSeats(organizationId);
    const account = await billingAccountForOrganization(prisma, organizationId);
    expect(account?.seats).toBe(2);
  });

  it("does not offer a second trial after the subscription ends", async () => {
    const { customerId } = (await billingAccountForOrganization(prisma, organizationId))!;
    emulator.setStatus(customerId, "canceled");
    await billing.sync(customerId);
    await expect(billing.status(owner)).resolves.toMatchObject({
      access: false,
      state: "canceled",
      trialAvailable: false,
    });
    await billing.checkout(owner);
    expect(emulator.checkouts.get(customerId)?.trialDays).toBeUndefined();
  });

  it("cancels the subscriptions of organizations a deleted owner held", async () => {
    const { customerId } = (await billingAccountForOrganization(prisma, organizationId))!;
    emulator.completeCheckout(customerId, "active");
    await billing.sync(customerId);
    await expect(billing.status(owner)).resolves.toMatchObject({ access: true });

    await billing.cancelForDeletedUser(memberId);
    await expect(billing.status(owner)).resolves.toMatchObject({ access: true });

    await billing.cancelForDeletedUser(ownerId);
    await expect(billing.status(owner)).resolves.toMatchObject({
      access: false,
      state: "canceled",
    });
  });

  it("replaces a customer the provider deleted instead of locking billing", async () => {
    const previous = (await billingAccountForOrganization(prisma, organizationId))!;
    emulator.deleteCustomer(previous.customerId);
    await billing.sync(previous.customerId);

    await expect(billing.checkout(owner)).resolves.toMatchObject({
      url: expect.stringContaining("checkout"),
    });
    const account = (await billingAccountForOrganization(prisma, organizationId))!;
    expect(account.customerId).not.toBe(previous.customerId);
    expect(account.subscribedAt).toEqual(previous.subscribedAt);
    expect(emulator.checkouts.get(account.customerId)?.trialDays).toBeUndefined();

    emulator.deleteCustomer(account.customerId);
    await expect(billing.portal(owner)).resolves.toMatchObject({
      url: expect.stringContaining("portal"),
    });
    expect((await billingAccountForOrganization(prisma, organizationId))!.customerId).not.toBe(
      account.customerId,
    );
  });

  it("sends an unpaid subscription to the portal instead of a second checkout", async () => {
    const { customerId } = (await billingAccountForOrganization(prisma, organizationId))!;
    await billing.checkout(owner);
    emulator.completeCheckout(customerId, "unpaid");
    await billing.sync(customerId);
    await expect(billing.status(owner)).resolves.toMatchObject({
      access: false,
      state: "unpaid",
    });
    await expect(billing.checkout(owner)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(billing.portal(owner)).resolves.toMatchObject({
      url: expect.stringContaining("portal"),
    });
  });

  it("keeps the first customer when two creates race", async () => {
    const raced = `${organizationId}-race`;
    await prisma.organization.create({
      data: { id: raced, name: "Race Org", slug: raced, createdAt: new Date() },
    });
    try {
      const accounts = await Promise.all(
        ["cus_race_a", "cus_race_b"].map((customerId) =>
          createBillingAccount(prisma, { organizationId: raced, customerId }),
        ),
      );
      expect(accounts[0]!.customerId).toBe(accounts[1]!.customerId);
    } finally {
      await prisma.organization.deleteMany({ where: { id: raced } });
    }
  });
});
