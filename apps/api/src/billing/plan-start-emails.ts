import type { BillingSubscriptionSnapshot } from "@rakazo/adapter-kit";
import { retry } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import type { ScheduleLifecycleEmail } from "../email/lifecycle-email.js";
import {
  AGENT_IMPORT_EMAIL_DELAY_MS,
  MODEL_CONNECTION_EMAIL_DELAY_MS,
} from "../email/lifecycle-email.js";

/**
 * The mails a plan's start queues for its owner. Concurrent syncs that both see the start queue
 * the same keyed jobs. Scheduling is outside the billing snapshot's transaction, so a brief
 * queue outage is ridden out here and a failure never stops the sync.
 */
export async function schedulePlanStartEmails(
  deps: {
    schedule?: ScheduleLifecycleEmail;
    modelCredits: boolean;
    ownerUserId: (organizationId: string) => Promise<string | undefined>;
  },
  organizationId: string,
  live: BillingSubscriptionSnapshot,
): Promise<void> {
  const { schedule } = deps;
  if (!schedule) return;
  // The owner is looked up inside the guarded call: a failed read must not stop the sync either.
  const queue = (kind: Parameters<ScheduleLifecycleEmail>[0], delayMs: number) =>
    bestEffort(
      `schedule the ${kind} email`,
      retry(
        async () => {
          const userId = await deps.ownerUserId(organizationId);
          if (userId)
            await schedule(kind, { organizationId, userId }, dueAfterStart(live, delayMs));
        },
        { attempts: 3 },
      ),
    );
  // An own-key plan runs nothing until its owner connects a model, so a day in they are
  // reminded if they still have not. Without model credits the deployment's own model serves
  // everyone, so nobody is asked.
  if (deps.modelCredits && live.byokPlan && !live.creditAmountCents)
    await queue("model-connection", MODEL_CONNECTION_EMAIL_DELAY_MS);
  // Two days into any plan its owner is shown how to bring an assistant over, unless they
  // already have: a day after the model reminder, so the two never arrive together.
  await queue("agent-import", AGENT_IMPORT_EMAIL_DELAY_MS);
}

/**
 * From the plan's own start, so every sync that sees it names the same time. A start recorded
 * later than the delay still leaves the owner the whole delay.
 */
function dueAfterStart(live: BillingSubscriptionSnapshot, delayMs: number): Date {
  const now = Date.now();
  const fromStart = (live.currentPeriodStartsAt?.getTime() ?? now) + delayMs;
  return new Date(fromStart > now ? fromStart : now + delayMs);
}
