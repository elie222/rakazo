import type {
  BillingByokCheckoutRequest,
  BillingCheckoutRequest,
  BillingCreditCheckoutRequest,
} from "@rakazo/adapter-kit";
import { BillingEmulator } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  billingAccountForOrganization,
  createBillingAccount,
  createDb,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBillingService } from "./billing.js";
import { expireCheckoutLease, watchCheckoutLeaseClaims } from "./checkout-lease.test-support.js";

const dbTests = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

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
    await service.purchaseCredits(actor, { amountCents: 2000, monthly: true });
    const results = await Promise.all(
      [1000, 2500, 5000].map((amountCents) =>
        service.purchaseCredits(actor, { amountCents, monthly: true }),
      ),
    );
    expect(results).toHaveLength(3);
    expect(provider.maxInFlight).toBe(1);
    expect(provider.customers.size).toBe(1);
  });
});

/** Holds the provider's customer and checkout calls until the test releases them. */
class GatedCheckoutEmulator extends BillingEmulator {
  private readonly customerGate = deferred();
  private readonly customerEntered = deferred();
  private readonly checkoutGate = deferred();
  private readonly checkoutEntered = deferred();
  private readonly canceled = deferred();

  constructor(namespace: string, modelCredits: boolean) {
    super({ modelCredits, namespace });
  }

  get customerCallStarted() {
    return this.customerEntered.promise;
  }

  get providerCallStarted() {
    return this.checkoutEntered.promise;
  }

  get cancellationRan() {
    return this.canceled.promise;
  }

  releaseCustomer() {
    this.customerGate.resolve();
  }

  releaseCheckout() {
    this.checkoutGate.resolve();
  }

  /** How many checkout sessions the provider still holds open. */
  openSessions() {
    return this.checkouts.size + this.byokCheckouts.size + this.creditCheckouts.size;
  }

  override async createCustomer(input: { email: string; organizationId: string }) {
    this.customerEntered.resolve();
    await this.customerGate.promise;
    return super.createCustomer(input);
  }

  private async hold<T>(open: () => Promise<T>): Promise<T> {
    this.checkoutEntered.resolve();
    await this.checkoutGate.promise;
    return open();
  }

  override async createCheckout(input: BillingCheckoutRequest) {
    return this.hold(() => super.createCheckout(input));
  }

  override async createByokCheckout(input: BillingByokCheckoutRequest) {
    return this.hold(() => super.createByokCheckout(input));
  }

  override async createCreditCheckout(input: BillingCreditCheckoutRequest) {
    return this.hold(() => super.createCreditCheckout(input));
  }

  override async cancelCustomerSubscriptions(customerId: string) {
    await super.cancelCustomerSubscriptions(customerId);
    this.canceled.resolve();
  }
}

dbTests("checkout and organization deletion", () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const userId = `deletion-owner-${stamp}`;
  const organizationIds: string[] = [];
  let prisma: PrismaClient, db: ReturnType<typeof createDb>;

  async function organizationFor(name: string) {
    const organizationId = `deletion-${name}-${stamp}`;
    const spaceId = `deletion-${name}-space-${stamp}`;
    const createdAt = new Date();
    organizationIds.push(organizationId);
    await prisma.organization.create({
      data: { id: organizationId, name: `Deletion ${name}`, slug: organizationId, createdAt },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "Personal", isDefault: true },
    });
    await prisma.member.create({
      data: {
        id: `deletion-${name}-member-${stamp}`,
        organizationId,
        userId,
        role: "owner",
        createdAt,
      },
    });
    const actor: Actor = {
      userId,
      spaceId,
      email: `deletion-${stamp}@rakazo.test`,
      isDeploymentOwner: false,
    };
    return { organizationId, spaceId, actor };
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!, { poolMax: 1 });
    prisma = asSystem(db.prisma);
    await prisma.user.create({
      data: {
        id: userId,
        name: "Deletion owner",
        email: `deletion-${stamp}@rakazo.test`,
        emailVerified: false,
      },
    });
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
    await prisma.user.delete({ where: { id: userId } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  const variants = [
    {
      name: "own-key",
      modelCredits: true,
      open: (service: ReturnType<typeof createBillingService>, actor: Actor) =>
        service.selectFunding(actor, "byok"),
    },
    {
      name: "managed",
      modelCredits: false,
      open: (service: ReturnType<typeof createBillingService>, actor: Actor) =>
        service.checkout(actor),
    },
    {
      name: "monthly credit",
      modelCredits: true,
      open: (service: ReturnType<typeof createBillingService>, actor: Actor) =>
        service.purchaseCredits(actor, { amountCents: 2000, monthly: true }),
    },
    {
      name: "one-time credit",
      modelCredits: true,
      open: (service: ReturnType<typeof createBillingService>, actor: Actor) =>
        service.purchaseCredits(actor, { amountCents: 2000, monthly: false }),
    },
  ] as const;

  for (const variant of variants) {
    it(`refuses a ${variant.name} checkout claimed for deletion while it was opening`, async () => {
      const { spaceId, actor } = await organizationFor(variant.name);
      const provider = new GatedCheckoutEmulator(
        `deletion-${variant.name}-${stamp}`,
        variant.modelCredits,
      );
      const service = createBillingService({ prisma, provider, webOrigin: "https://example.test" });
      const pending = variant.open(service, actor);
      // The checkout has passed its entry check and is creating the customer, before it takes
      // the organization's lease; the deletion claim lands in that window.
      await provider.customerCallStarted;
      await prisma.space.update({ where: { id: spaceId }, data: { deletingAt: new Date() } });
      provider.releaseCustomer();
      provider.releaseCheckout();
      await expect(pending).rejects.toMatchObject({ code: "CONFLICT" });
      expect(provider.openSessions()).toBe(0);
    });
  }

  it("expires a checkout that was still opening when the cancellation ran", async () => {
    const { organizationId, actor } = await organizationFor("cancel");
    const provider = new GatedCheckoutEmulator(`deletion-cancel-${stamp}`, false);
    const watched = watchCheckoutLeaseClaims(prisma);
    const service = createBillingService({
      prisma: watched.prisma,
      provider,
      webOrigin: "https://example.test",
    });
    provider.releaseCustomer(); // This test gates the checkout call, not the customer create.
    const pending = service.checkout(actor);
    await provider.providerCallStarted;
    const canceling = service.cancelOrganizationSubscriptions(organizationId);
    // A cancellation that does not wait runs here, before the session exists; one that waits
    // finds the checkout holding the lease and queues behind it.
    await Promise.race([provider.cancellationRan, watched.leaseRefused]);
    provider.releaseCheckout();
    await expect(pending).resolves.toMatchObject({ url: expect.any(String) });
    await canceling;
    const { customerId } = (await billingAccountForOrganization(prisma, organizationId))!;
    expect(() => provider.completeCheckout(customerId)).toThrow();
  });

  it("keeps the checkout trial hold until cancellation can verify subscription state", async () => {
    const provider = new GatedCheckoutEmulator(`deletion-sync-${stamp}`, true);
    const { organizationId } = await accountFor("sync", provider);
    await prisma.user.update({
      where: { id: userId },
      data: {
        byokTrialCheckoutOrganizationId: organizationId,
        byokTrialCheckoutExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    vi.spyOn(provider, "getCustomerSubscription").mockRejectedValueOnce(
      new Error("Provider unavailable"),
    );
    const service = createBillingService({ prisma, provider, webOrigin: "https://example.test" });
    await expect(service.cancelOrganizationSubscriptions(organizationId)).rejects.toThrow(
      "Provider unavailable",
    );
    await expect(prisma.user.findUniqueOrThrow({ where: { id: userId } })).resolves.toMatchObject({
      byokTrialCheckoutOrganizationId: organizationId,
    });

    await service.cancelOrganizationSubscriptions(organizationId);
    await expect(prisma.user.findUniqueOrThrow({ where: { id: userId } })).resolves.toMatchObject({
      byokTrialCheckoutOrganizationId: null,
    });
  });

  it("refuses a session created after the checkout lease lapsed and was taken over", async () => {
    const { organizationId, actor } = await organizationFor("lapse");
    const provider = new GatedCheckoutEmulator(`deletion-lapse-${stamp}`, false);
    const service = createBillingService({ prisma, provider, webOrigin: "https://example.test" });
    provider.releaseCustomer();
    const pending = service.checkout(actor);
    await provider.providerCallStarted;
    // The lease lapses while the provider call is still pending — a renewal cannot resurrect
    // a lapsed lease — and the deletion's cancellation takes it over and runs to the end.
    await expireCheckoutLease(prisma, organizationId);
    const canceling = service.cancelOrganizationSubscriptions(organizationId);
    await provider.cancellationRan;
    provider.releaseCheckout();
    await expect(pending).rejects.toMatchObject({ code: "CONFLICT" });
    await canceling;
    // The cancellation ran before this session existed, so the checkout expires it itself.
    await vi.waitFor(() => expect(provider.openSessions()).toBe(0));
  });

  it("cancels the customer a checkout swapped in while the cancellation waited", async () => {
    const provider = new GatedCheckoutEmulator(`deletion-swap-${stamp}`, true);
    const { organizationId, actor } = await accountFor("swap", provider);
    const { customerId: previous } = (await billingAccountForOrganization(prisma, organizationId))!;
    provider.deleteCustomer(previous);
    const service = createBillingService({ prisma, provider, webOrigin: "https://example.test" });
    const pending = service.purchaseCredits(actor, { amountCents: 2000, monthly: false });
    await provider.providerCallStarted;
    // Holding the lease, the checkout finds its customer gone and swaps in a new one.
    const canceling = service.cancelOrganizationSubscriptions(organizationId);
    provider.releaseCheckout();
    await expect(pending).resolves.toMatchObject({ url: expect.any(String) });
    await canceling;
    const { customerId } = (await billingAccountForOrganization(prisma, organizationId))!;
    expect(customerId).not.toBe(previous);
    expect(provider.openSessions()).toBe(0);
  });

  /** An organization whose billing account already exists. */
  async function accountFor(name: string, provider: GatedCheckoutEmulator) {
    const organization = await organizationFor(name);
    provider.releaseCustomer();
    const { customerId } = await provider.createCustomer({
      email: organization.actor.email,
      organizationId: organization.organizationId,
    });
    await createBillingAccount(prisma, { organizationId: organization.organizationId, customerId });
    return organization;
  }
});
