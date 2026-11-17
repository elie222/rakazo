import { describe, expect, it } from "vitest";
import type { BillingStatus } from "./billing.js";
import { billingNote, cancelPlanOffered, isNoPlanToCancel, NO_PLAN_TO_CANCEL } from "./billing.js";

function status(overrides: Partial<BillingStatus> = {}): BillingStatus {
  return {
    access: true,
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
  };
}

describe("cancelling a plan or trial", () => {
  it("names what an owner would cancel", () => {
    expect(cancelPlanOffered(status({ state: "trialing" }))).toBe("trial");
    expect(cancelPlanOffered(status())).toBe("plan");
    for (const state of ["past_due", "unpaid", "paused"] as const)
      expect(cancelPlanOffered(status({ state }))).toBe("plan");
  });

  it("is not offered to members, without a customer, once cancelling, or when nothing is live", () => {
    expect(cancelPlanOffered(status({ canManage: false }))).toBeNull();
    expect(cancelPlanOffered(status({ hasCustomer: false }))).toBeNull();
    expect(cancelPlanOffered(status({ cancelAtPeriodEnd: true }))).toBeNull();
    expect(cancelPlanOffered(status({ cancelAtPeriodEnd: true, state: "trialing" }))).toBeNull();
    for (const state of ["none", "canceled", "incomplete"] as const)
      expect(cancelPlanOffered(status({ state }))).toBeNull();
  });
});

describe("the billing note", () => {
  it("tells members only the owner manages billing, even when a card is on file", () => {
    expect(billingNote(status({ canManage: false }))).toBe("owner_only");
    expect(billingNote(status({ canManage: false, hasCustomer: false }))).toBe("owner_only");
  });

  it("tells an owner with no customer nothing will be charged, and an owner with one nothing", () => {
    expect(billingNote(status({ hasCustomer: false, state: "none" }))).toBe("nothing_charged");
    expect(billingNote(status())).toBeNull();
  });
});

describe("recognising the refusal of a cancel", () => {
  it("reads the code from any error that carries one", () => {
    expect(isNoPlanToCancel({ code: NO_PLAN_TO_CANCEL })).toBe(true);
    expect(isNoPlanToCancel(Object.assign(new Error("No plan"), { code: NO_PLAN_TO_CANCEL }))).toBe(
      true,
    );
  });

  it("is not any other failure, whatever it is thrown as", () => {
    expect(isNoPlanToCancel({ code: "CONFLICT" })).toBe(false);
    expect(isNoPlanToCancel(new Error(NO_PLAN_TO_CANCEL))).toBe(false);
    for (const value of [null, undefined, "NO_PLAN_TO_CANCEL", 409, {}])
      expect(isNoPlanToCancel(value)).toBe(false);
  });
});
