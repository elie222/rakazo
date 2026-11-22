import type { BillingStatus } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  billingDate,
  ownKeySubscriptionCents,
  subscribedTier,
  subscriptionLive,
  tierPriceCents,
} from "./subscription.js";

type TierOffer = NonNullable<BillingStatus["byokTiers"]>[number];

const standard: TierOffer = {
  tier: "standard",
  name: "Standard",
  monthlyPriceCents: 1200,
  annualPriceCents: 12000,
  computerSize: "standard",
  computerHours: 20,
};
const pro: TierOffer = {
  ...standard,
  tier: "pro",
  name: "Pro",
  monthlyPriceCents: 4900,
  annualPriceCents: null,
};

function status(overrides: Partial<BillingStatus> = {}): BillingStatus {
  return {
    access: true,
    funding: "byok",
    byokPriceCents: 1200,
    byokFreeUntil: null,
    canManage: true,
    trialAvailable: false,
    trialDays: 7,
    state: "active",
    price: null,
    seats: 1,
    trialEndsAt: null,
    currentPeriodEndsAt: null,
    cancelAtPeriodEnd: false,
    hasCustomer: true,
    ...overrides,
  } as BillingStatus;
}

describe("subscriptionLive", () => {
  it("counts states that still bill", () => {
    expect(subscriptionLive("trialing")).toBe(true);
    expect(subscriptionLive("paused")).toBe(true);
    expect(subscriptionLive("canceled")).toBe(false);
    expect(subscriptionLive("incomplete")).toBe(false);
    expect(subscriptionLive("none")).toBe(false);
  });
});

describe("ownKeySubscriptionCents", () => {
  it("is the price a live own-key plan was bought at", () => {
    expect(ownKeySubscriptionCents(status())).toBe(1200);
  });

  it("is null for credits, a free period or a lapsed plan", () => {
    expect(ownKeySubscriptionCents(status({ funding: "credits" }))).toBeNull();
    expect(ownKeySubscriptionCents(status({ monthlyAmountCents: 3000 }))).toBeNull();
    expect(ownKeySubscriptionCents(status({ byokFreeUntil: "2026-12-01T00:00:00Z" }))).toBeNull();
    expect(ownKeySubscriptionCents(status({ state: "canceled" }))).toBeNull();
    expect(ownKeySubscriptionCents(status({ byokPriceCents: null }))).toBeNull();
  });
});

describe("tiers", () => {
  it("prices a tier at the interval, null when it is not offered there", () => {
    expect(tierPriceCents(standard, "month")).toBe(1200);
    expect(tierPriceCents(standard, "year")).toBe(12000);
    expect(tierPriceCents(pro, "year")).toBeNull();
  });

  it("finds the subscribed tier, Standard when none is set", () => {
    const byokTiers = [standard, pro];
    expect(subscribedTier(status({ byokTiers, byokTier: "pro" }))).toBe(pro);
    expect(subscribedTier(status({ byokTiers }))).toBe(standard);
    expect(subscribedTier(status())).toBeUndefined();
  });
});

describe("billingDate", () => {
  const at = "2026-12-02T00:00:00Z";

  it("names when a trial ends, a plan ends, or it renews", () => {
    expect(billingDate(status({ state: "trialing", trialEndsAt: at }))).toEqual({
      kind: "trial",
      at,
    });
    expect(billingDate(status({ currentPeriodEndsAt: at, cancelAtPeriodEnd: true }))).toEqual({
      kind: "ends",
      at,
    });
    expect(billingDate(status({ currentPeriodEndsAt: at }))).toEqual({ kind: "renews", at });
  });

  it("has no date for a plan that waits on its owner", () => {
    expect(billingDate(status({ state: "paused", currentPeriodEndsAt: at }))).toBeNull();
    expect(billingDate(status({ state: "unpaid", currentPeriodEndsAt: at }))).toBeNull();
    expect(billingDate(status())).toBeNull();
  });
});
