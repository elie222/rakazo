import { redactSecrets, textEditsGiven, writesRoutinePrompt } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import { reviewOwnerMessages } from "../../approvals/review-owner-messages.js";
import { outsideOnlyTargets, taskPromptIsOutside } from "../../approvals/review-target-sources.js";
import { findRoutinesTarget } from "../../routines/routine-target.js";
import { editText } from "../../tools/text-edits.js";
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
 * The stored prompt a routine edit replaces and, for a call that sends edits, the prompt they make
 * of it, each redacted like the call, so the review can show only the change. Edits are applied
 * before redacting, as the save applies them. Found as the update finds it (this bot's or a
 * managed bot's routine, this thread's in a group); a failed lookup leaves the review of the call
 * as it was sent.
 */
export async function routinePromptsForReview(
  ctx: RunContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ current?: string; edited?: string }> {
  if (toolName !== "schedule_update" || !writesRoutinePrompt(args)) return {};
  const routineId = typeof args.routineId === "string" ? args.routineId.trim() : "";
  if (!routineId) return {};
  const routine = await bestEffort(
    "auto_review.routine_prompt",
    findRoutinesTarget(
      { prisma: ctx.deps.prisma, fleetRun: ctx.fleetRun, botId: ctx.bot.id, thread: ctx.thread },
      toolName,
      args,
    ).then((target) =>
      "error" in target
        ? null
        : ctx.deps.prisma.routine.findFirst({
            where: {
              id: routineId,
              spaceId: ctx.run.spaceId,
              botId: target.botId,
              ...(target.groupThreadId ? { threadId: target.groupThreadId } : {}),
            },
            select: { prompt: true },
          }),
    ),
  );
  if (!routine) return {};
  const edited = textEditsGiven(args.promptEdits)
    ? editText(routine.prompt, args.promptEdits, "promptEdits", "the prompt")
    : undefined;
  return {
    current: redactSecrets(routine.prompt, ctx.secrets),
    ...(edited?.ok ? { edited: redactSecrets(edited.text, ctx.secrets) } : {}),
  };
}
