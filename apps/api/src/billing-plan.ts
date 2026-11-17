import type { BillingSubscriptionSnapshot } from "@rakazo/adapter-kit";
import type { AnalyticsEvent, ByokInterval } from "@rakazo/contracts";
import {
  BYOK_TIERS,
  ByokTierSchema,
  byokTierPriceCents,
  NO_PLAN_TO_CANCEL,
  sandboxAllowanceHours,
} from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { BillingAccount } from "@rakazo/db";
import { hasBillingAccess, needsBillingPortal } from "@rakazo/db";

/**
 * Only the own-key plan has a trial: credits are resold at cost. An organization that has
 * subscribed before, or was given a free own-key period, has had its trial, and so has its owner
 * when any organization of theirs has.
 */
export function byokTrialAvailable(
  account: { subscribedAt: Date | null } | null,
  credits: { byokFreeUntil: Date | null },
  ownerHadOne: boolean,
) {
  return !ownerHadOne && !account?.subscribedAt && !credits.byokFreeUntil;
}

/** Cancelling was asked for, but the provider shows no live plan that is not already set to end. */
export class NoPlanToCancelError extends ClientError {
  constructor() {
    super("CONFLICT", "No plan to cancel", NO_PLAN_TO_CANCEL);
    this.name = "NoPlanToCancelError";
  }
}

/** Billing was asked to start something for an organization whose deletion has begun. */
export class OrganizationBeingDeletedError extends ClientError {
  constructor() {
    super("CONFLICT", "Organization is being deleted");
    this.name = "OrganizationBeingDeletedError";
  }
}

export type PlanTerms = Omit<Extract<AnalyticsEvent, { name: "checkout_opened" }>, "name">;

/** The plan a subscription bills, as analytics reports it; monthly credits include own-key. */
export function planTerms(live: BillingSubscriptionSnapshot): PlanTerms | null {
  if (live.creditAmountCents)
    return { plan: "credits", interval: "month", amountCents: live.creditAmountCents };
  if (live.byokPlan && live.byokPriceCents)
    return {
      plan: "own_key",
      tier: live.byokTier ?? "standard",
      interval: live.byokInterval ?? "month",
      amountCents: live.byokPriceCents,
    };
  return null;
}

/** A subscriber keeps the own-key price they signed up at until the subscription ends. */
export function subscribedByokPrice(account: BillingAccount | null) {
  const status = account?.status ?? null;
  if (!account?.byokPriceCents || !(hasBillingAccess(status) || needsBillingPortal(status)))
    return null;
  const interval: ByokInterval = account.byokInterval === "year" ? "year" : "month";
  const tier = ByokTierSchema.catch("standard").parse(account.byokTier ?? "standard");
  return { cents: account.byokPriceCents, interval, tier };
}

/** The tiers on offer, in order; empty when the own-key plan is free. */
export function byokTierOffers() {
  return ByokTierSchema.options.flatMap((tier) => {
    const monthlyPriceCents = byokTierPriceCents(tier, "month");
    if (monthlyPriceCents === null) return [];
    const terms = BYOK_TIERS[tier];
    return [
      {
        tier,
        name: terms.name,
        monthlyPriceCents,
        annualPriceCents: byokTierPriceCents(tier, "year"),
        computerSize: terms.computerSize,
        computerHours: sandboxAllowanceHours(terms.computerAllowanceCents),
      },
    ];
  });
}
