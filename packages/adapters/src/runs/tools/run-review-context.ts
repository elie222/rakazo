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

/**
 * The stored prompt a routine edit replaces, redacted like the call, so the review can show only
 * the change. Found as the update finds it (this bot's routine, this thread's in a group); a failed
 * lookup leaves the review of the whole new prompt.
 */
export async function currentRoutinePrompt(
  ctx: RunContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  if (toolName !== "schedule_update" || typeof args.prompt !== "string") return undefined;
  const routineId = typeof args.routineId === "string" ? args.routineId.trim() : "";
  if (!routineId) return undefined;
  const routine = await bestEffort(
    "auto_review.routine_prompt",
    ctx.deps.prisma.routine.findFirst({
      where: {
        id: routineId,
        spaceId: ctx.run.spaceId,
        botId: ctx.bot.id,
        ...(ctx.thread.groupId ? { threadId: ctx.thread.id } : {}),
      },
      select: { prompt: true },
    }),
  );
  return routine ? redactSecrets(routine.prompt, ctx.secrets) : undefined;
}
