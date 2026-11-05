import type { BillingProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import { createBillingService } from "./billing.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
};
const price = { amount: 1000, currency: "usd", interval: "month" as const, intervalCount: 1 };

function service(getPrice: BillingProvider["getPrice"], role = "owner") {
  const prisma = {
    space: { findUnique: vi.fn().mockResolvedValue({ organizationId: "org-1" }) },
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
        return { id: "cs-1", url: "https://checkout.example.com" };
      }),
    } as unknown as BillingProvider;
    const billing = createBillingService({
      prisma: prisma as unknown as PrismaClient,
      provider,
      webOrigin: "https://app.example.com",
    });
    for (const monthly of [true, false]) {
      await expect(billing.purchaseCredits(actor, { amountCents: 1000, monthly })).resolves.toEqual(
        { url: "https://checkout.example.com" },
      );
    }
    expect(provider.createCreditCheckout).toHaveBeenCalledTimes(2);
  });
});

/** A monthly credit checkout whose provider call the test finishes; the lease's end state is set. */
function leaseFixture(held: () => Promise<unknown>, stopsOnAbort = false) {
  const account = { organizationId: "org-1", customerId: "cus-1" };
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
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
      findFirst: vi.fn(held),
      updateMany,
    },
    modelCreditAccount: {
      upsert: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  let finish!: () => void;
  let signal: AbortSignal | undefined;
  const provider = {
    describe: () => ({ capabilities: { modelCredits: true } }),
    createCreditCheckout: vi.fn(
      (_input: unknown, deadline?: AbortSignal) =>
        new Promise((resolve, reject) => {
          signal = deadline;
          finish = () => resolve({ id: "cs-late", url: "https://checkout.example.com" });
          if (stopsOnAbort) deadline?.addEventListener("abort", () => reject(deadline.reason));
        }),
    ),
    expireCheckout: vi.fn().mockResolvedValue(undefined),
  };
  const billing = createBillingService({
    prisma: prisma as unknown as PrismaClient,
    provider: provider as unknown as BillingProvider,
    webOrigin: "https://app.example.com",
  });
  const pending = billing.purchaseCredits(actor, { amountCents: 1000, monthly: true });
  pending.catch(() => {});
  return {
    pending,
    provider,
    finish: () => finish(),
    signal: () => signal,
    renewals: () =>
      updateMany.mock.calls.filter(([args]) => args.where.checkoutLeaseExpiresAt?.gt).length,
  };
}

describe("checkout lease", () => {
  it("stops renewing the lease over a hung provider call and expires its late session", async () => {
    vi.useFakeTimers();
    try {
      // The lease lapsed while the call hung, so it is no longer held at the end.
      const { pending, provider, finish, renewals } = leaseFixture(async () => null);
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      const renewed = renewals();
      expect(renewed).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(renewals()).toBe(renewed);
      finish();
      await expect(pending).rejects.toMatchObject({ code: "CONFLICT" });
      expect(provider.expireCheckout).toHaveBeenCalledWith("cs-late");
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the provider call when renewal stops and answers like a lost lease", async () => {
    vi.useFakeTimers();
    try {
      // The lease is still held: only the deadline ends the checkout.
      const { pending, provider, signal } = leaseFixture(
        async () => ({ organizationId: "org-1" }),
        true,
      );
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      expect(signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(signal()?.aborted).toBe(true);
      await expect(pending).rejects.toMatchObject({ code: "CONFLICT" });
      expect(provider.expireCheckout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires a session the provider returned after the deadline", async () => {
    vi.useFakeTimers();
    try {
      const { pending, provider, finish } = leaseFixture(async () => ({ organizationId: "org-1" }));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      finish();
      await expect(pending).rejects.toMatchObject({ code: "CONFLICT" });
      expect(provider.expireCheckout).toHaveBeenCalledWith("cs-late");
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires the session when the lease cannot be checked, then reports the failure", async () => {
    const failure = new Error("database unavailable");
    const { pending, provider, finish } = leaseFixture(async () => {
      throw failure;
    });
    await vi.waitFor(() => expect(provider.createCreditCheckout).toHaveBeenCalled());
    finish();
    await expect(pending).rejects.toBe(failure);
    expect(provider.expireCheckout).toHaveBeenCalledWith("cs-late");
  });

  it("retries expiring a late session and still refuses it when the provider keeps failing", async () => {
    const { pending, provider, finish } = leaseFixture(async () => null);
    provider.expireCheckout
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce(undefined);
    await vi.waitFor(() => expect(provider.createCreditCheckout).toHaveBeenCalled());
    finish();
    await expect(pending).rejects.toMatchObject({ code: "CONFLICT" });
    expect(provider.expireCheckout).toHaveBeenCalledTimes(2);

    const logged = vi.spyOn(getLogger(), "error").mockImplementation(() => {});
    try {
      const failing = leaseFixture(async () => null);
      failing.provider.expireCheckout.mockRejectedValue(new Error("provider unavailable"));
      await vi.waitFor(() => expect(failing.provider.createCreditCheckout).toHaveBeenCalled());
      failing.finish();
      await expect(failing.pending).rejects.toMatchObject({ code: "CONFLICT" });
      expect(failing.provider.expireCheckout).toHaveBeenCalledTimes(3);
      expect(logged).toHaveBeenCalledWith(expect.any(String), expect.any(Error), {
        "billing.checkout_session_id": "cs-late",
      });
    } finally {
      logged.mockRestore();
    }
  });
});
