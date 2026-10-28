import { BillingEmulator } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, billingAccountForOrganization, createDb, spaceHasModelAccess } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBillingService } from "./billing.js";

const dbTests =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
dbTests("own-key plan", () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const userId = `byok-owner-${stamp}`,
    organizationId = `byok-org-${stamp}`,
    spaceId = `byok-space-${stamp}`;
  const actor: Actor = {
    userId,
    spaceId,
    email: `byok-${stamp}@rakazo.test`,
    isDeploymentOwner: false,
  };
  const provider = new BillingEmulator({ modelCredits: true, namespace: `byok-${stamp}` });
  let prisma: PrismaClient,
    db: ReturnType<typeof createDb>,
    service: ReturnType<typeof createBillingService>;
  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
    const createdAt = new Date();
    await prisma.user.create({
      data: { id: userId, name: "Demo owner", email: actor.email, emailVerified: false },
    });
    await prisma.organization.create({
      data: { id: organizationId, name: "Own-key fixture", slug: organizationId, createdAt },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "Personal", isDefault: true },
    });
    await prisma.member.create({
      data: { id: `member-${stamp}`, organizationId, userId, role: "owner", createdAt },
    });
    service = createBillingService({ prisma, provider, webOrigin: "https://example.test" });
  });
  afterAll(async () => {
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.user.delete({ where: { id: userId } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("stays free without a checkout during the free period", async () => {
    const freeUntil = new Date(Date.now() + 86_400_000);
    await prisma.modelCreditAccount.create({
      data: { organizationId, mode: "byok", byokFreeUntil: freeUntil },
    });
    await expect(service.selectFunding(actor, "byok")).resolves.toEqual({ ok: true });
    await expect(service.status(actor)).resolves.toMatchObject({
      access: true,
      byokFreeUntil: freeUntil.toISOString(),
    });
    await expect(spaceHasModelAccess(prisma, spaceId)).resolves.toBe(true);
    expect(await billingAccountForOrganization(prisma, organizationId)).toBeNull();
  });

  it("loses access when the free period ends", async () => {
    await prisma.modelCreditAccount.update({
      where: { organizationId },
      data: { byokFreeUntil: new Date(Date.now() - 1000) },
    });
    await expect(service.status(actor)).resolves.toMatchObject({
      access: false,
      byokFreeUntil: null,
    });
    await expect(spaceHasModelAccess(prisma, spaceId)).resolves.toBe(false);
  });

  it("grants access once the plan is paid", async () => {
    const { url } = await service.checkout(actor);
    expect(url).toContain("/byok/");
    const customer = (await billingAccountForOrganization(prisma, organizationId))!.customerId;
    // The free period was this organization's trial.
    expect(provider.byokCheckouts.get(customer)?.trialDays).toBeUndefined();
    provider.completeByokCheckout(customer);
    await service.sync(customer);
    await expect(service.status(actor)).resolves.toMatchObject({
      access: true,
      funding: "byok",
      state: "active",
      balanceUsd: 0,
    });
    await expect(spaceHasModelAccess(prisma, spaceId)).resolves.toBe(true);
    await expect(service.checkout(actor)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("ends the plan at renewal once monthly credits start", async () => {
    await service.purchaseCredits(actor, { amountCents: 2000, monthly: true });
    const customer = (await billingAccountForOrganization(prisma, organizationId))!.customerId;
    provider.completeCreditCheckout(customer);
    await service.sync(customer);
    await expect(service.status(actor)).resolves.toMatchObject({
      funding: "credits",
      monthlyAmountCents: 2000,
    });
    expect(
      provider.subscriptions.find((subscription) => !subscription.creditAmountCents),
    ).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
  });

  it("switches to the plan when its payment syncs, without the checkout return", async () => {
    const customer = (await billingAccountForOrganization(prisma, organizationId))!.customerId;
    for (const subscription of provider.subscriptions) subscription.status = "canceled";
    await service.sync(customer);
    await expect(service.status(actor)).resolves.toMatchObject({
      access: true,
      funding: "credits",
    });
    await expect(service.selectFunding(actor, "byok")).resolves.toMatchObject({
      url: expect.stringContaining("/byok/"),
    });
    await expect(service.status(actor)).resolves.toMatchObject({ funding: "credits" });
    provider.completeByokCheckout(customer);
    await service.sync(customer);
    await expect(service.status(actor)).resolves.toMatchObject({ funding: "byok", access: true });
  });

  it("ends the plan when monthly credits start already set not to renew", async () => {
    await service.purchaseCredits(actor, { amountCents: 2000, monthly: true });
    const customer = (await billingAccountForOrganization(prisma, organizationId))!.customerId;
    provider.completeCreditCheckout(customer);
    provider.subscriptions.at(-1)!.cancelAtPeriodEnd = true;
    await service.sync(customer);
    expect(
      provider.subscriptions.find(
        (subscription) => subscription.byokPlan && subscription.status === "active",
      ),
    ).toMatchObject({ cancelAtPeriodEnd: true });
  });
});
