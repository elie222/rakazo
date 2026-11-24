import type { BillingStatus, ByokInterval } from "@rakazo/contracts";
import { ByokTierSchema } from "@rakazo/contracts";

type ByokTierOffer = NonNullable<BillingStatus["byokTiers"]>[number];

/** Subscription states that still bill: access now, or resumed from the billing portal. */
const LIVE_STATES: readonly BillingStatus["state"][] = [
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
];

/** Whether a subscription in `state` still bills. */
export function subscriptionLive(state: BillingStatus["state"]): boolean {
  return LIVE_STATES.includes(state);
}

/**
 * What an own-key subscriber pays each `byokInterval`, which stays at the price they subscribed
 * at. Null without a live own-key subscription.
 */
export function ownKeySubscriptionCents(status: BillingStatus): number | null {
  if (status.funding !== "byok" || !status.byokPriceCents || status.byokFreeUntil) return null;
  return !status.monthlyAmountCents && subscriptionLive(status.state)
    ? status.byokPriceCents
    : null;
}

/** What a tier costs every `interval`; null when it is not offered at that interval. */
export function tierPriceCents(offer: ByokTierOffer, interval: ByokInterval): number | null {
  return interval === "year" ? offer.annualPriceCents : offer.monthlyPriceCents;
}

/** The offered tier the organization is on, Standard when it has none. */
export function subscribedTier(status: BillingStatus): ByokTierOffer | undefined {
  const tier = ByokTierSchema.catch("standard").parse(status.byokTier);
  return status.byokTiers?.find((offer) => offer.tier === tier);
}

/** The next date the subscription changes: its trial ends, it ends, or it renews. */
export function billingDate(
  status: BillingStatus,
): { kind: "trial" | "ends" | "renews"; at: string } | null {
  if (status.state === "trialing" && status.trialEndsAt) {
    return { kind: "trial", at: status.trialEndsAt };
  }
  // Unpaid and paused subscriptions do not renew until the owner resumes them.
  if (!status.currentPeriodEndsAt || status.state === "unpaid" || status.state === "paused") {
    return null;
  }
  if (status.cancelAtPeriodEnd || status.state === "canceled") {
    return { kind: "ends", at: status.currentPeriodEndsAt };
  }
  return { kind: "renews", at: status.currentPeriodEndsAt };
}
