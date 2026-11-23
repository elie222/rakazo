import type { BillingSubscriptionSnapshot } from "@rakazo/adapter-kit";
import type { BillingAccount } from "@rakazo/db";
import { needsBillingPortal } from "@rakazo/db";

/**
 * How a trial ended, once that is known: true when its first charge was paid, false when the
 * subscription stopped without one, null while the trial runs or the charge is still pending
 * (a subscription turns active before its first charge is collected). A failed first charge
 * that is settled later ends it a second time, as true.
 */
export function trialOutcome(
  previous: Pick<BillingAccount, "status" | "trialEndsAt" | "paidAt">,
  live: Pick<BillingSubscriptionSnapshot, "status" | "paidAt">,
): boolean | null {
  const unpaidTrial = previous.trialEndsAt !== null && !previous.paidAt;
  if (unpaidTrial && needsBillingPortal(previous.status)) return live.paidAt ? true : null;
  if (previous.status !== "trialing" && !(unpaidTrial && previous.status === "active")) return null;
  if (live.paidAt) return true;
  return live.status === "trialing" || live.status === "active" ? null : false;
}
