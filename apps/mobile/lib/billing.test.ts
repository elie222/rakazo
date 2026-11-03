import type { BillingStatus } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { currentPlan, ownKeyOffer, planEndsAt, purchaseCompleted } from "./billing";

vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("react-native", () => ({ Linking: { openURL: vi.fn() } }));

function status(overrides: Partial<BillingStatus> = {}): BillingStatus {
  return {
    access: false,
    funding: null,
    byokPriceCents: 1000,
    byokFreeUntil: null,
    canManage: true,
    trialAvailable: true,
    trialDays: 7,
    state: "none",
    price: null,
    seats: 1,
    trialEndsAt: null,
    currentPeriodEndsAt: null,
    cancelAtPeriodEnd: false,
    hasCustomer: false,
    ...overrides,
  };
}

describe("own-key offer", () => {
  it("leads with the trial until it has been used", () => {
    expect(ownKeyOffer(status())).toBe("trial");
    expect(ownKeyOffer(status({ trialAvailable: false }))).toBe("subscribe");
  });

  it("asks a free period to subscribe rather than start a trial", () => {
    expect(ownKeyOffer(status({ byokFreeUntil: "2026-11-01T00:00:00.000Z" }))).toBe("subscribe");
  });

  it("needs no payment when the own-key plan is free", () => {
    expect(ownKeyOffer(status({ byokPriceCents: null }))).toBe("free");
  });
});

describe("plan end", () => {
  it("is the trial end while trialing", () => {
    const trialEndsAt = "2026-11-03T00:00:00.000Z";
    expect(planEndsAt(status({ state: "trialing", trialEndsAt }))).toBe(trialEndsAt);
  });

  it("is the period end only once the renewal is canceled", () => {
    const currentPeriodEndsAt = "2026-11-27T00:00:00.000Z";
    expect(planEndsAt(status({ state: "active", currentPeriodEndsAt }))).toBeNull();
    expect(
      planEndsAt(status({ state: "active", currentPeriodEndsAt, cancelAtPeriodEnd: true })),
    ).toBe(currentPeriodEndsAt);
  });
});

describe("current plan", () => {
  it("is only a plan the organization can run bots on", () => {
    expect(currentPlan(status({ funding: "byok" }))).toBeNull();
    expect(currentPlan(status({ access: true, funding: "byok" }))).toBe("byok");
    expect(currentPlan(status({ access: true, funding: "credits" }))).toBe("credits");
  });
});

describe("purchase completed", () => {
  it("is a checkout that grants access", () => {
    expect(purchaseCompleted(status(), status({ access: true, state: "trialing" }))).toBe(true);
    expect(purchaseCompleted(status(), status())).toBe(false);
  });

  it("is not a canceled checkout from a free period that still has access", () => {
    const free = status({
      access: true,
      funding: "byok",
      byokFreeUntil: "2026-11-01T00:00:00.000Z",
    });
    expect(purchaseCompleted(free, free)).toBe(false);
    expect(
      purchaseCompleted(free, status({ access: true, funding: "byok", state: "active" })),
    ).toBe(true);
  });

  it("is a change from own key to monthly credits", () => {
    const ownKey = status({ access: true, funding: "byok", state: "active" });
    expect(
      purchaseCompleted(
        ownKey,
        status({ access: true, funding: "credits", state: "active", monthlyAmountCents: 2000 }),
      ),
    ).toBe(true);
  });
});
