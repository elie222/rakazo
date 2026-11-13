import type { ProductAnalytics } from "@rakazo/adapter-kit";
import { BillingEmulator } from "@rakazo/adapters";
import type { Actor, AnalyticsEvent } from "@rakazo/contracts";
import { BYOK_TIERS } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, billingAccountForOrganization, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBillingService, planLayout, TRIAL_DAYS } from "./billing.js";

const dbTests = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;
dbTests("plan choice funnel", () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const userId = `funnel-owner-${stamp}`,
    organizationId = `funnel-org-${stamp}`,
    spaceId = `funnel-space-${stamp}`;
  const actor: Actor = {
    userId,
    spaceId,
    email: `funnel-${stamp}@rakazo.test`,
    isDeploymentOwner: false,
  };
  const provider = new BillingEmulator({ modelCredits: true, namespace: `funnel-${stamp}` });
  const events: AnalyticsEvent[] = [];
  const analytics: ProductAnalytics = {
    capture: (captured, event) => {
      expect(captured).toBe(userId);
      events.push(event);
    },
    flush: async () => {},
  };
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
      data: { id: organizationId, name: "Funnel fixture", slug: organizationId, createdAt },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "Personal", isDefault: true },
    });
    await prisma.member.create({
      data: { id: `member-${stamp}`, organizationId, userId, role: "owner", createdAt },
    });
    service = createBillingService({
      prisma,
      provider,
      webOrigin: "https://example.test",
      analytics,
    });
  });
  afterAll(async () => {
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.user.delete({ where: { id: userId } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("lays out the plan choice the same way on every read", async () => {
    await expect(service.status(actor)).resolves.toMatchObject({
      planLayout: planLayout(organizationId),
    });
  });

  it("reports the chosen tier from checkout through the end of its trial, once each", async () => {
    await service.purchaseCredits(actor, { amountCents: 3000, monthly: true });
    await service.selectFunding(actor, "byok", undefined, "year", "pro");
    const customer = (await billingAccountForOrganization(prisma, organizationId))!.customerId;
    expect(provider.byokCheckouts.get(customer)).toMatchObject({
      tier: "pro",
      interval: "year",
      trialDays: TRIAL_DAYS,
    });
    const terms = {
      plan: "own_key",
      tier: "pro",
      interval: "year",
      amountCents: BYOK_TIERS.pro.annualPriceCents,
    } as const;
    provider.completeByokCheckout(customer);
    await service.sync(customer);
    await service.sync(customer);
    provider.setStatus(customer, "active");
    await service.sync(customer);
    await service.sync(customer);
    expect(events).toEqual([
      { name: "checkout_opened", plan: "credits", interval: "month", amountCents: 3000 },
      { name: "checkout_opened", ...terms },
      { name: "subscription_started", ...terms, trial: true },
      { name: "trial_ended", ...terms, converted: true },
    ]);
  });
});
