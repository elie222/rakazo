import type { BillingCreditCheckoutRequest } from "@rakazo/adapter-kit";
import { BillingEmulator } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBillingService } from "./billing.js";

const dbTests =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

/** Records how many monthly checkouts are open at once and reads the database mid-call. */
class SlowCheckoutEmulator extends BillingEmulator {
  inFlight = 0;
  maxInFlight = 0;
  constructor(
    namespace: string,
    private readonly duringCall: () => Promise<unknown>,
  ) {
    super({ modelCredits: true, namespace });
  }

  override async createCreditCheckout(input: BillingCreditCheckoutRequest) {
    this.maxInFlight = Math.max(this.maxInFlight, ++this.inFlight);
    try {
      await this.duringCall();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return await super.createCreditCheckout(input);
    } finally {
      this.inFlight--;
    }
  }
}

dbTests("billing checkout coordination", () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const userId = `checkout-owner-${stamp}`,
    organizationId = `checkout-org-${stamp}`,
    spaceId = `checkout-space-${stamp}`;
  const actor: Actor = {
    userId,
    spaceId,
    email: `checkout-${stamp}@rakazo.test`,
    isDeploymentOwner: false,
  };
  let prisma: PrismaClient, db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    // One connection: a checkout that held it over the provider call would block the read below.
    db = createDb(process.env.DATABASE_URL!, { poolMax: 1 });
    prisma = asSystem(db.prisma);
    const createdAt = new Date();
    await prisma.user.create({
      data: { id: userId, name: "Checkout owner", email: actor.email, emailVerified: false },
    });
    await prisma.organization.create({
      data: { id: organizationId, name: "Checkout fixture", slug: organizationId, createdAt },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "Personal", isDefault: true },
    });
    await prisma.member.create({
      data: { id: `member-${stamp}`, organizationId, userId, role: "owner", createdAt },
    });
  });
  afterAll(async () => {
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.user.delete({ where: { id: userId } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("opens one monthly checkout at a time without holding a connection over the provider", async () => {
    const provider = new SlowCheckoutEmulator(`checkout-${stamp}`, () =>
      prisma.user.findUnique({ where: { id: userId } }),
    );
    const service = createBillingService({ prisma, provider, webOrigin: "https://example.test" });
    await service.purchaseCredits(actor, { amountCents: 1000, monthly: true });
    const results = await Promise.all(
      [1000, 2500, 5000].map((amountCents) =>
        service.purchaseCredits(actor, { amountCents, monthly: true }),
      ),
    );
    expect(results).toHaveLength(3);
    expect(provider.maxInFlight).toBe(1);
    expect(provider.customers.size).toBe(1);
    await expect(
      prisma.billingAccount.findUniqueOrThrow({ where: { organizationId } }),
    ).resolves.toMatchObject({ checkoutLeaseId: null, checkoutLeaseExpiresAt: null });
  });
});
