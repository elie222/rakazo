import type { BillingProvider } from "@rakazo/adapter-kit";
import { BillingCustomerNotFoundError, BillingPaymentNotCompletedError } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createBillingService } from "./billing.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
};
const price = { amount: 1000, currency: "usd", interval: "month" as const, intervalCount: 1 };

function service(
  getPrice: BillingProvider["getPrice"],
  role = "owner",
  provides: { capabilities?: Record<string, boolean>; extra?: Record<string, unknown> } = {},
) {
  const prisma = {
    space: {
      findUnique: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    member: {
      findUnique: vi.fn().mockResolvedValue({ role }),
      count: vi.fn().mockResolvedValue(3),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([{ userId: "owner-1", role: "owner" }]),
    },
    billingAccount: { findUnique: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn().mockResolvedValue({ billingTrialUsedAt: null }) },
  } as unknown as PrismaClient;
  const provider = {
    describe: () => ({
      capabilities: { trials: true, portal: true, ...provides.capabilities },
    }),
    getPrice: vi.fn(getPrice),
    endTrial: vi.fn(),
    ...provides.extra,
  } as unknown as BillingProvider;
  return {
    provider,
    prisma,
    billing: createBillingService({ prisma, provider, webOrigin: "https://app.example.com" }),
  };
}

describe("billing status", () => {
  it("reads the price once and reuses it", async () => {
    const { billing, provider } = service(async () => price);
    await expect(billing.status(actor)).resolves.toMatchObject({ price, seats: 3 });
    await billing.status(actor);
    expect(provider.getPrice).toHaveBeenCalledTimes(1);
  });

  it("still answers when the price cannot be read", async () => {
    const { billing } = service(async () => {
      throw new Error("provider unavailable");
    });
    await expect(billing.status(actor)).resolves.toMatchObject({ price: null, access: false });
  });

  it("refuses checkout, portal, and ending the trial for non-owners", async () => {
    const { billing, provider } = service(async () => price, "member");
    await expect(billing.checkout(actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(billing.portal(actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(billing.endTrial(actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(provider.endTrial).not.toHaveBeenCalled();
  });

  it("answers payment required when the card is not charged", async () => {
    const { billing, provider, prisma } = service(async () => price);
    vi.mocked(prisma.billingAccount.findUnique).mockResolvedValue({
      organizationId: "org-1",
      customerId: "cus-1",
    } as never);
    vi.mocked(provider.endTrial!).mockRejectedValue(new BillingPaymentNotCompletedError());
    await expect(billing.endTrial(actor)).rejects.toMatchObject({
      code: "PAYMENT_REQUIRED",
      status: 402,
    });
  });
});

describe("opening the portal on cancelling", () => {
  type Stored = Record<string, unknown>;
  const stored: Stored = {
    organizationId: "org-1",
    customerId: "cus-1",
    subscriptionId: "sub-stale",
    status: "trialing",
    cancelAtPeriodEnd: false,
  };

  function portalService(
    account: Stored,
    live: Stored | null,
    provides?: Parameters<typeof service>[2],
  ) {
    const current = { ...account };
    const { billing, prisma, provider } = service(async () => price, "owner", provides);
    vi.mocked(prisma.billingAccount.findUnique).mockImplementation((async () => current) as never);
    Object.assign(prisma.billingAccount, {
      findUniqueOrThrow: vi.fn(async () => current),
      updateMany: vi.fn(async ({ data }: { data: Stored }) => {
        Object.assign(current, data);
        return { count: 1 };
      }),
      count: vi.fn().mockResolvedValue(1),
    });
    Object.assign(prisma, {
      // The checkout lease's take and check, and the sync's start.
      $queryRaw: vi.fn().mockResolvedValue([{ fence: 1n, startedAt: new Date() }]),
      $executeRaw: vi.fn().mockResolvedValue(0),
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
    });
    Object.assign(prisma.user, { updateMany: vi.fn().mockResolvedValue({ count: 0 }) });
    Object.assign(provider, {
      getCustomerSubscription: vi.fn(async () => live),
      createPortal: vi.fn(async () => ({ url: "https://portal.example.com" })),
    });
    return { billing, provider, prisma };
  }

  const liveSubscription = {
    subscriptionId: "sub-live",
    subscriptionItemId: "si-1",
    priceId: "price-1",
    status: "trialing",
    seats: 1,
    trialEndsAt: null,
    currentPeriodStartsAt: null,
    currentPeriodEndsAt: null,
    cancelAtPeriodEnd: false,
    endedAt: null,
  };

  it("names the subscription the provider reports, not a stale stored one", async () => {
    const { billing, provider } = portalService(stored, liveSubscription);
    await expect(billing.portal(actor, "mobile", "cancel")).resolves.toEqual({
      url: "https://portal.example.com",
    });
    expect(provider.createPortal).toHaveBeenCalledWith({
      customerId: "cus-1",
      returnUrl: "https://app.example.com/api/v1/billing/return?client=mobile",
      cancelSubscriptionId: "sub-live",
    });
  });

  it("returns a web cancel through the API, which syncs what the portal changed", async () => {
    const { billing, provider } = portalService(stored, liveSubscription);
    await billing.portal(actor, undefined, "cancel");
    expect(provider.createPortal).toHaveBeenCalledWith({
      customerId: "cus-1",
      returnUrl: "https://app.example.com/api/v1/billing/return",
      cancelSubscriptionId: "sub-live",
    });
  });

  it("holds the checkout lease while it opens the session, and gives it back", async () => {
    const { billing, provider, prisma } = portalService(stored, liveSubscription);
    const claims = () =>
      vi
        .mocked(prisma.billingAccount.updateMany)
        .mock.calls.filter(([args]) => "checkoutLeaseId" in (args.data as Stored));
    vi.mocked(provider.createPortal).mockImplementation(async () => {
      // Taken (a lease id written) and not yet released (cleared).
      expect(claims().map(([args]) => (args.data as Stored).checkoutLeaseId)).toEqual([
        expect.any(String),
      ]);
      return { url: "https://portal.example.com" };
    });
    await billing.portal(actor, undefined, "cancel");
    expect(claims().map(([args]) => (args.data as Stored).checkoutLeaseId)).toEqual([
      expect.any(String),
      null,
    ]);
  });

  it("reads the customer again once it holds the lease", async () => {
    const { billing, provider, prisma } = portalService(stored, liveSubscription);
    const replaced = { ...stored, customerId: "cus-2" };
    // The first read is the entry check; the lease wait is when another request replaces the customer.
    vi.mocked(prisma.billingAccount.findUnique)
      .mockResolvedValueOnce(stored as never)
      .mockResolvedValue(replaced as never);
    await billing.portal(actor, undefined, "cancel");
    expect(provider.getCustomerSubscription).not.toHaveBeenCalledWith("cus-1");
    expect(provider.createPortal).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cus-2" }),
    );
  });

  it("refuses when the organization starts being deleted while it waits for the lease", async () => {
    const { billing, provider, prisma } = portalService(stored, liveSubscription);
    // The entry check finds nothing; the check under the lease finds the deletion.
    vi.mocked(prisma.space.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "space-1" } as never);
    await expect(billing.portal(actor, undefined, "cancel")).rejects.toMatchObject({
      name: "OrganizationBeingDeletedError",
      kind: "CONFLICT",
      code: "CONFLICT",
      message: "Organization is being deleted",
    });
    expect(provider.getCustomerSubscription).not.toHaveBeenCalled();
    expect(provider.createPortal).not.toHaveBeenCalled();
  });

  it("opens the session although credit purchases cannot be read", async () => {
    const listCreditPurchases = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const { billing, provider } = portalService(stored, liveSubscription, {
      capabilities: { modelCredits: true },
      extra: { listCreditPurchases },
    });
    await expect(billing.portal(actor, undefined, "cancel")).resolves.toEqual({
      url: "https://portal.example.com",
    });
    expect(listCreditPurchases).not.toHaveBeenCalled();
    expect(provider.createPortal).toHaveBeenCalledWith(
      expect.objectContaining({ cancelSubscriptionId: "sub-live" }),
    );
  });

  it("stores what it read when it refuses, although credit purchases cannot be read", async () => {
    const listCreditPurchases = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const { billing, prisma, provider } = portalService(
      stored,
      { ...liveSubscription, cancelAtPeriodEnd: true },
      { capabilities: { modelCredits: true }, extra: { listCreditPurchases } },
    );
    await expect(billing.portal(actor, undefined, "cancel")).rejects.toMatchObject({
      kind: "CONFLICT",
      code: "NO_PLAN_TO_CANCEL",
    });
    expect(listCreditPurchases).not.toHaveBeenCalled();
    expect(prisma.billingAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cancelAtPeriodEnd: true }) }),
    );
    expect(provider.createPortal).not.toHaveBeenCalled();
  });

  it("stores what it read when it refuses", async () => {
    const { billing, prisma } = portalService(stored, {
      ...liveSubscription,
      cancelAtPeriodEnd: true,
    });
    await expect(billing.portal(actor, undefined, "cancel")).rejects.toMatchObject({
      code: "NO_PLAN_TO_CANCEL",
    });
    expect(prisma.billingAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cancelAtPeriodEnd: true }) }),
    );
  });

  it("opens the plain portal without the intent", async () => {
    const { billing, provider } = portalService(stored, liveSubscription);
    await billing.portal(actor);
    expect(provider.createPortal).toHaveBeenCalledWith({
      customerId: "cus-1",
      returnUrl: "https://app.example.com/app",
    });
  });

  it("refuses when the plan ended or is already set to end", async () => {
    for (const live of [
      null,
      { ...liveSubscription, status: "canceled" },
      { ...liveSubscription, cancelAtPeriodEnd: true },
    ]) {
      const { billing, provider } = portalService(stored, live);
      await expect(billing.portal(actor, undefined, "cancel")).rejects.toMatchObject({
        kind: "CONFLICT",
        code: "NO_PLAN_TO_CANCEL",
      });
      expect(provider.createPortal).not.toHaveBeenCalled();
    }
  });

  it("refuses when the customer is deleted between the read and opening the session", async () => {
    const { billing, provider, prisma } = portalService(stored, liveSubscription);
    vi.mocked(provider.createPortal).mockRejectedValue(new BillingCustomerNotFoundError());
    await expect(billing.portal(actor, undefined, "cancel")).rejects.toMatchObject({
      kind: "CONFLICT",
      code: "NO_PLAN_TO_CANCEL",
    });
    // The earlier live read is replaced by the none the customer's deletion left.
    const snapshots = vi
      .mocked(prisma.billingAccount.updateMany)
      .mock.calls.map(([a]) => a.data as Stored)
      .filter((data) => "subscriptionId" in data);
    expect(snapshots.map((data) => data.subscriptionId)).toEqual(["sub-live", null]);
  });

  it("passes any other failure of opening the session through", async () => {
    const { billing, provider } = portalService(stored, liveSubscription);
    vi.mocked(provider.createPortal).mockRejectedValue(new Error("provider unavailable"));
    await expect(billing.portal(actor, undefined, "cancel")).rejects.toThrow(
      "provider unavailable",
    );
  });

  it("refuses a customer the provider deleted, which reads as having no subscription, and stores that", async () => {
    // A deleted customer reads as having no live subscription (the conformance suite accepts
    // null or a canceled snapshot); either way the cancel is refused.
    const { billing, provider, prisma } = portalService(stored, null);
    Object.assign(provider, { createCustomer: vi.fn() });
    await expect(billing.portal(actor, undefined, "cancel")).rejects.toMatchObject({
      kind: "CONFLICT",
      code: "NO_PLAN_TO_CANCEL",
    });
    expect(provider.createCustomer).not.toHaveBeenCalled();
    expect(provider.createPortal).not.toHaveBeenCalled();
    expect(prisma.billingAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ subscriptionId: null }) }),
    );
  });
});

describe("model credit checkout", () => {
  it("calls the provider without holding a database transaction", async () => {
    let openTransactions = 0;
    const account = { organizationId: "org-1", customerId: "cus-1" };
    const prisma = {
      space: {
        findUnique: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      member: {
        findUnique: vi.fn().mockResolvedValue({ role: "owner" }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      billingAccount: {
        findUnique: vi.fn().mockResolvedValue(account),
        findFirst: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      modelCreditAccount: {
        upsert: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
        update: vi.fn().mockResolvedValue({}),
      },
      // The checkout lease's take, check and release, and the claim's lock.
      $queryRaw: vi.fn().mockResolvedValue([{ fence: 1n }]),
      $executeRaw: vi.fn().mockResolvedValue(0),
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
        openTransactions++;
        try {
          return await run(prisma);
        } finally {
          openTransactions--;
        }
      }),
    };
    const provider = {
      describe: () => ({ capabilities: { modelCredits: true } }),
      createCreditCheckout: vi.fn(async () => {
        expect(openTransactions).toBe(0);
        return { url: "https://checkout.example.com" };
      }),
    } as unknown as BillingProvider;
    const billing = createBillingService({
      prisma: prisma as unknown as PrismaClient,
      provider,
      webOrigin: "https://app.example.com",
    });
    for (const monthly of [true, false]) {
      await expect(billing.purchaseCredits(actor, { amountCents: 2000, monthly })).resolves.toEqual(
        { url: "https://checkout.example.com" },
      );
    }
    expect(provider.createCreditCheckout).toHaveBeenCalledTimes(2);
  });
});
