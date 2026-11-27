import type { BillingByokPlan, BillingSubscriptionSnapshot } from "@rakazo/adapter-kit";
import type { AnalyticsEvent, ByokInterval, ByokTier } from "@rakazo/contracts";
import {
  BYOK_TIERS,
  ByokTierSchema,
  byokTierPriceCents,
  sandboxAllowanceHours,
} from "@rakazo/contracts";
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

type PlanTerms = Omit<Extract<AnalyticsEvent, { name: "checkout_opened" }>, "name">;

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

/** Whether this sync is the one that records a subscription starting, trial or paid. */
export function subscriptionStarted(previous: BillingAccount, live: BillingSubscriptionSnapshot) {
  // A checkout whose first payment was still pending syncs as incomplete before it starts.
  return (
    hasBillingAccess(live.status) &&
    (live.subscriptionId !== previous.subscriptionId || previous.status === "incomplete")
  );
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
export function byokTierOffers(sizeChoice: boolean, hourMicros?: number) {
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
        computerHours: sandboxAllowanceHours(terms.computerAllowanceCents, hourMicros),
        ...(sizeChoice ? { computerSizeChoice: true as const } : {}),
      },
    ];
  });
}

/** The yearly plan a monthly subscriber can switch to; null when it would not save them money. */
export function yearlyPlan(from: BillingByokPlan): BillingByokPlan | null {
  const amountCents = byokTierPriceCents(from.tier, "year");
  // A subscriber on an older, cheaper price would pay more.
  return from.interval === "month" && amountCents !== null && from.amountCents * 12 > amountCents
    ? { tier: from.tier, interval: "year", amountCents }
    : null;
}

/** The plan at another tier and the same interval; null when it is the same tier or not offered. */
export function planAtTier(from: BillingByokPlan, tier: ByokTier): BillingByokPlan | null {
  const amountCents = byokTierPriceCents(tier, from.interval);
  return tier !== from.tier && amountCents !== null
    ? { tier, interval: from.interval, amountCents }
    : null;
}

/** The plan a cancelled trial continues on; the one it already has keeps the price it started at. */
export function renewedPlan(
  from: BillingByokPlan,
  tier: ByokTier,
  interval: ByokInterval,
): BillingByokPlan | null {
  if (tier === from.tier && interval === from.interval) return from;
  const amountCents = byokTierPriceCents(tier, interval);
  return amountCents === null ? null : { tier, interval, amountCents };
}
