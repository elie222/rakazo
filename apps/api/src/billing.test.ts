import type { BillingProvider } from "@rakazo/adapter-kit";
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

function service(getPrice: BillingProvider["getPrice"], role = "owner") {
  const prisma = {
    space: { findUnique: vi.fn().mockResolvedValue({ organizationId: "org-1" }) },
    member: {
      findUnique: vi.fn().mockResolvedValue({ role }),
      count: vi.fn().mockResolvedValue(3),
    },
    billingAccount: { findUnique: vi.fn().mockResolvedValue(null) },
  } as unknown as PrismaClient;
  const provider = { getPrice: vi.fn(getPrice) } as unknown as BillingProvider;
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

  it("refuses checkout and portal for non-owners", async () => {
    const { billing } = service(async () => price, "member");
    await expect(billing.checkout(actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(billing.portal(actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
