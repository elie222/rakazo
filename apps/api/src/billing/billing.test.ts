import type { BillingProvider } from "@rakazo/adapter-kit";
import { BillingPaymentNotCompletedError } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createBillingService } from "./billing.js";
import { trialOutcome } from "./trial-outcome.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
};
const price = { amount: 1000, currency: "usd", interval: "month" as const, intervalCount: 1 };

function service(getPrice: BillingProvider["getPrice"], role = "owner") {
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
    describe: () => ({ capabilities: { trials: true, portal: true } }),
    getPrice: vi.fn(getPrice),
    endTrial: vi.fn(),
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

describe("trial outcome", () => {
  const trialEndsAt = new Date("2030-01-08T00:00:00Z");
  const trialing = { status: "trialing", trialEndsAt, paidAt: null };
  const chargePending = { status: "active", trialEndsAt, paidAt: null };
  const paidAt = new Date("2030-01-08T01:00:00Z");

  it("waits for the first charge instead of counting an active subscription as paid", () => {
    expect(trialOutcome(trialing, { status: "trialing" })).toBeNull();
    expect(trialOutcome(trialing, { status: "active" })).toBeNull();
    expect(trialOutcome(chargePending, { status: "active" })).toBeNull();
    expect(trialOutcome(trialing, { status: "active", paidAt })).toBe(true);
    expect(trialOutcome(chargePending, { status: "active", paidAt })).toBe(true);
  });

  it("ends unconverted when the charge fails or the trial is cancelled", () => {
    expect(trialOutcome(chargePending, { status: "past_due" })).toBe(false);
    expect(trialOutcome(trialing, { status: "past_due" })).toBe(false);
    expect(trialOutcome(trialing, { status: "canceled" })).toBe(false);
  });

  it("converts when a failed first charge is settled later", () => {
    const overdue = { status: "past_due", trialEndsAt, paidAt: null };
    expect(trialOutcome(overdue, { status: "past_due" })).toBeNull();
    expect(trialOutcome(overdue, { status: "canceled" })).toBeNull();
    expect(trialOutcome(overdue, { status: "active", paidAt })).toBe(true);
  });

  it("reports nothing once the trial's end is recorded", () => {
    expect(
      trialOutcome({ status: "active", trialEndsAt, paidAt }, { status: "past_due" }),
    ).toBeNull();
    expect(
      trialOutcome({ status: "past_due", trialEndsAt, paidAt }, { status: "active", paidAt }),
    ).toBeNull();
    expect(
      trialOutcome({ status: "active", trialEndsAt: null, paidAt: null }, { status: "canceled" }),
    ).toBeNull();
  });
});
