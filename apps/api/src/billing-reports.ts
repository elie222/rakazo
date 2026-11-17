import type { BillingSubscriptionSnapshot, ProductAnalytics } from "@rakazo/adapter-kit";
import type { BillingAccount, PrismaClient } from "@rakazo/db";
import { hasBillingAccess } from "@rakazo/db";
import { planTerms } from "./billing-plan.js";
import type { createExperiments } from "./experiments.js";

/** What a stored subscription snapshot that differs from the one it replaced tells analytics. */
export function createBillingReports(deps: {
  prisma: PrismaClient;
  analytics?: ProductAnalytics;
  experiments: ReturnType<typeof createExperiments>;
}) {
  const { prisma, analytics, experiments } = deps;

  async function ownerUserId(organizationId: string) {
    const owner = await prisma.member.findFirst({
      where: { organizationId, role: { contains: "owner" } },
      orderBy: { createdAt: "asc" },
      select: { userId: true },
    });
    return owner?.userId;
  }

  return {
    async cancellation(previous: BillingAccount, live: BillingSubscriptionSnapshot) {
      if (
        !analytics ||
        !(live.cancellationReason || live.cancellationComment) ||
        (live.cancellationReason === (previous.cancellationReason ?? undefined) &&
          live.cancellationComment === (previous.cancellationComment ?? undefined))
      )
        return;
      const owner = await ownerUserId(previous.organizationId);
      if (!owner) return;
      analytics.capture(owner, {
        name: "subscription_cancel_feedback",
        ...(live.cancellationReason ? { reason: live.cancellationReason } : {}),
        commented: Boolean(live.cancellationComment),
      });
    },

    /**
     * Reports a new subscription, or the end of its trial, when a sync records it. Concurrent
     * syncs can both see the change, so each event carries the subscription and a time from its
     * snapshot, which the analytics provider deduplicates on.
     */
    async planChange(previous: BillingAccount, live: BillingSubscriptionSnapshot) {
      const same = live.subscriptionId === previous.subscriptionId;
      // A checkout whose first payment was still pending syncs as incomplete before it starts.
      const started = hasBillingAccess(live.status) && (!same || previous.status === "incomplete");
      const trialEnded = same && previous.status === "trialing" && live.status !== "trialing";
      const terms = planTerms(live);
      if (!analytics || !terms || !(started || trialEnded)) return;
      const owner = await ownerUserId(previous.organizationId);
      if (!owner) return;
      const at = (started ? live.currentPeriodStartsAt : live.trialEndsAt) ?? new Date();
      analytics.capture(
        owner,
        started
          ? { name: "subscription_started", ...terms, trial: live.status === "trialing" }
          : { name: "trial_ended", ...terms, converted: live.status === "active" },
        { id: live.subscriptionId, at },
        experiments.tags("plan-layout", previous.organizationId),
      );
    },
  };
}
