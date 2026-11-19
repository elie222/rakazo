import { redactSecrets } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import { reviewOwnerMessages } from "../../approvals/review-owner-messages.js";
import { outsideOnlyTargets, taskPromptIsOutside } from "../../approvals/review-target-sources.js";
import type { RunContext } from "../assembly/run-context.js";

/**
 * What Auto Review is told beyond the call: the owner's earlier messages, and the call's targets
 * that only outside content this run read named. A new site and a memory save are judged by their
 * own rules and send nothing to a party, so they get no targets.
 */
export async function reviewOwnerContext(
  ctx: RunContext,
  reviewArgs: Record<string, unknown>,
  withTargets: boolean,
) {
  // Extra context only: a failed lookup drops it and never fails the review.
  const earlier =
    (await bestEffort("auto_review.owner_messages", ctx.trust.loadEarlierOwnerMessages())) ?? [];
  const ownerMessages = reviewOwnerMessages(
    earlier.map((text) => redactSecrets(text, ctx.secrets)),
  );
  const targets = withTargets
    ? outsideOnlyTargets(reviewArgs, {
        ownerWords: [
          await ctx.trust.loadOwnerWords(),
          ...earlier,
          // Only a task that cannot hold outside text counts as the owner's words.
          ...(taskPromptIsOutside(ctx.run, ctx.source.ownerStartedRun) ? [] : [ctx.task.prompt]),
        ],
        outsideText: ctx.state.outsideText,
      })
    : [];
  return {
    ...(ownerMessages.length ? { ownerMessages } : {}),
    ...(targets.length ? { outsideOnlyTargets: targets } : {}),
  };
}
