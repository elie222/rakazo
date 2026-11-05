import { BillingEmulator } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  billingAccountForOrganization,
  createDb,
  extendByokFreePeriod,
  FREE_MONTH_DAYS,
  keepOrganizationTrialUse,
  ownerHadTrial,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBillingService, TRIAL_DAYS } from "./billing.js";

const dbTests =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

/** One owner and their first two organizations, each addressed through its own space. */
async function ownerWithOrganizations(prisma: PrismaClient, stamp: string, name: string) {
  const userId = `trial-owner-${name}-${stamp}`;
  const email = `trial-owner-${name}-${stamp}@rakazo.test`;
  await prisma.user.create({
    data: { id: userId, name: `Trial owner ${name}`, email, emailVerified: false },
  });
  const organizations = await Promise.all(
    ["a", "b"].map(async (suffix) => {
      const organizationId = `trial-owner-${name}-${suffix}-${stamp}`;
      const spaceId = `trial-owner-${name}-${suffix}-space-${stamp}`;
      const createdAt = new Date();
      await prisma.organization.create({
        data: {
          id: organizationId,
          name: `Trial owner ${name} ${suffix}`,
          slug: organizationId,
          createdAt,
        },
      });
      await prisma.space.create({
        data: { id: spaceId, organizationId, name: "Personal", isDefault: true },
      });
      await prisma.member.create({
        data: {
          id: `trial-owner-${name}-${suffix}-member-${stamp}`,
          organizationId,
          userId,
          role: "owner",
          createdAt,
        },
      });
      const actor: Actor = { userId, spaceId, email, isDeploymentOwner: false };
      return { organizationId, actor };
    }),
  );
  return { userId, first: organizations[0]!, second: organizations[1]! };
}

dbTests("own-key trial across organizations", () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const provider = new BillingEmulator({ modelCredits: true, namespace: `trial-owner-${stamp}` });
  const userIds: string[] = [];
  const organizationIds: string[] = [];
  let prisma: PrismaClient,
    db: ReturnType<typeof createDb>,
    service: ReturnType<typeof createBillingService>;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
    service = createBillingService({ prisma, provider, webOrigin: "https://example.test" });
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function customerOf(organizationId: string) {
    const { customerId } = (await billingAccountForOrganization(prisma, organizationId))!;
    return customerId;
  }

  async function ownerWith(name: string) {
    const owner = await ownerWithOrganizations(prisma, stamp, name);
    userIds.push(owner.userId);
    organizationIds.push(owner.first.organizationId, owner.second.organizationId);
    return owner;
  }

  it("keeps the trial for the same organization's reopened checkout", async () => {
    const owner = await ownerWith("reopen");
    await service.selectFunding(owner.first.actor, "byok");
    await service.selectFunding(owner.first.actor, "byok");
    const customerId = await customerOf(owner.first.organizationId);
    expect(provider.byokCheckouts.get(customerId)?.trialDays).toBe(TRIAL_DAYS);
  });

  it("holds the owner's one trial while another organization's checkout is open", async () => {
    const owner = await ownerWith("hold");
    await service.selectFunding(owner.first.actor, "byok");
    const first = await customerOf(owner.first.organizationId);
    expect(provider.byokCheckouts.get(first)?.trialDays).toBe(TRIAL_DAYS);
    // The owner's one trial is held by the first organization's open session.
    await expect(service.status(owner.second.actor)).resolves.toMatchObject({
      trialAvailable: false,
    });
    await service.selectFunding(owner.second.actor, "byok");
    const second = await customerOf(owner.second.organizationId);
    expect(provider.byokCheckouts.get(second)?.trialDays).toBeUndefined();
    provider.completeByokCheckout(first);
    provider.completeByokCheckout(second);
    await service.sync(first);
    await service.sync(second);
    // Only the first organization's subscription can be on a trial.
    await expect(provider.getCustomerSubscription(first)).resolves.toMatchObject({
      status: "trialing",
    });
    await expect(provider.getCustomerSubscription(second)).resolves.toMatchObject({
      status: "active",
      trialEndsAt: null,
    });
  });

  it("releases the hold once the checkout session has expired", async () => {
    const owner = await ownerWith("expire");
    await service.selectFunding(owner.first.actor, "byok");
    // The hold lasts as long as the session can be paid; after that it no longer counts.
    await prisma.user.update({
      where: { id: owner.userId },
      data: { byokTrialCheckoutExpiresAt: new Date(Date.now() - 1000) },
    });
    await service.selectFunding(owner.second.actor, "byok");
    const second = await customerOf(owner.second.organizationId);
    expect(provider.byokCheckouts.get(second)?.trialDays).toBe(TRIAL_DAYS);
  });

  it("keeps free own-key days counted as the owner's used trial after the organization goes", async () => {
    const owner = await ownerWith("delete");
    // A free period granted before the owner-level mark existed.
    await prisma.modelCreditAccount.upsert({
      where: { organizationId: owner.first.organizationId },
      create: {
        organizationId: owner.first.organizationId,
        byokFreeUntil: new Date(Date.now() + FREE_MONTH_DAYS * 86_400_000),
      },
      update: {},
    });
    await keepOrganizationTrialUse(prisma, owner.first.organizationId);
    await prisma.organization.delete({ where: { id: owner.first.organizationId } });
    await expect(ownerHadTrial(prisma, owner.userId, "byok")).resolves.toBe(true);
    // Any subscription uses up every trial kind; free own-key days use up only the own-key one.
    await expect(ownerHadTrial(prisma, owner.userId, "managed")).resolves.toBe(false);
    await service.selectFunding(owner.second.actor, "byok");
    const second = await customerOf(owner.second.organizationId);
    expect(provider.byokCheckouts.get(second)?.trialDays).toBeUndefined();
  });

  it("uses the trial up when free own-key days are granted, not only when they are kept", async () => {
    const owner = await ownerWith("grant");
    await prisma.$transaction(async (tx) => {
      await tx.modelCreditAccount.upsert({
        where: { organizationId: owner.second.organizationId },
        create: { organizationId: owner.second.organizationId },
        update: {},
      });
      await extendByokFreePeriod(tx, owner.second.organizationId, FREE_MONTH_DAYS);
    });
    // The organization's rows disappear without a billing-aware deletion, as when the last
    // member leaves an empty organization; the granted days still count as the used trial.
    await prisma.organization.delete({ where: { id: owner.second.organizationId } });
    await expect(ownerHadTrial(prisma, owner.userId, "byok")).resolves.toBe(true);
    await expect(ownerHadTrial(prisma, owner.userId, "managed")).resolves.toBe(false);
  });
});
