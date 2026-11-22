import type { AdapterContext, AutoReviewRequest } from "@rakazo/adapter-kit";
import type { connectorKindFromToolName, resolveActionApprovalForTools } from "@rakazo/core";
import {
  applyJudgeDecision,
  BACKGROUND_HELPER_TRIGGER,
  HELPER_RESULT_TRIGGER,
  lastingWriteKind,
  redactSecrets,
} from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import type { AutoReviewChecker } from "../../approvals/auto-review.js";
import { ownComputerReviewArgs, redactToolArgsForReview } from "../../approvals/auto-review.js";
import type { AutoReviewCandidate } from "../../approvals/auto-review-backups.js";
import { reviewWithBackups } from "../../approvals/auto-review-backups.js";
import { changedTextReviewArgs } from "../../approvals/changed-text-review-args.js";
import type { RunContext, RunTrust } from "../assembly/run-context.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { autoReviewCheckerProvider, includedAutoReviewChecker } from "../turn/run-auto-review.js";
import { currentRoutinePrompt, reviewOwnerContext } from "./run-review-context.js";
import { auditToolCall } from "./run-tool-audit.js";
import type { AppliedEffect } from "./run-tool-gate.js";

/** A gated call the approval model is about to judge, with what decides how it is judged. */
export type ToolReview = {
  name: string;
  args: Record<string, unknown>;
  connectorKind: ReturnType<typeof connectorKindFromToolName>;
  /** A URL to a site the run was not given, judged on its own against the owner's words. */
  newSiteUrl: string | undefined;
  savedContextWrite: boolean;
  ownComputerAction: boolean;
  /** The page a page action types into, as the gate judged it; none when it may have changed. */
  pageUrl: string | undefined;
  matchingRules: ReturnType<typeof resolveActionApprovalForTools>["matchingRules"];
  gated: boolean;
  applied: AppliedEffect | undefined;
  injectedReview: ExecutorDeps["autoReview"];
  checker: AutoReviewChecker | null | undefined;
  reviewSettings: Awaited<ReturnType<RunTrust["loadApprovalModel"]>> | null;
  memberChecker: boolean;
};

/** Runs whose task is the product's own prompt: a new bot's intro, and the wrap-up after a call. */
const PRODUCT_PROMPT_TRIGGERS = new Set(["created", "call_end"]);

/**
 * Run the configured reviewer (and its backups) on a call and store its verdict on the
 * effect. Returns nothing when there is no reviewer or the run was cancelled.
 */
export async function reviewToolCall(
  ctx: RunContext,
  review: ToolReview,
): Promise<{ reason: string | undefined; decision: "ask" | "allow" } | undefined> {
  const { deps, run, runId, bot, thread, context } = ctx;
  const { name, args, connectorKind, newSiteUrl, gated, applied } = review;
  const { injectedReview, checker, reviewSettings, memberChecker } = review;
  if (!injectedReview && !checker && !reviewSettings?.backups.length) return;
  try {
    const delegated =
      run.trigger === BACKGROUND_HELPER_TRIGGER || run.trigger === HELPER_RESULT_TRIGGER;
    // A follow-up's task is a fixed "continue" prompt; the owner's latest words are its message.
    const continuation = run.trigger === "follow_up" || run.trigger === "messaging";
    const userTask = delegated
      ? await ctx.trust.loadOwnerWords()
      : (continuation && (await ctx.trust.loadOwnerWords()).trim()) || ctx.task.prompt;
    // Older helpers and deleted origins cannot establish authorization from their brief.
    if (delegated && !userTask.trim()) return { decision: "ask", reason: undefined };
    const botDescription = redactSecrets(`${bot.name}\n${bot.description}`, ctx.secrets);
    // A webhook run's task prompt carries the delivery, which someone else wrote, so the checker
    // gets only the owner's routine. With no routine to judge against, a person decides.
    const outsideRun = run.trigger === "webhook";
    const ownerWords = outsideRun ? await ctx.trust.loadOwnerWords() : "";
    if (outsideRun && !ownerWords.trim()) return { reason: undefined, decision: "ask" };
    // A new site, a write that outlives the run (a memory or skill save, a routine, the bot's own
    // instructions), or an action on the bot's own computer after outside content, is judged on the
    // owner's own words only: the task prompt of a webhook or bot-started run carries text someone
    // else wrote, which must not authorize a write that later runs with the owner's trust. A new
    // bot's intro and a call's wrap-up keep their task, the product's own prompt, which no one else
    // wrote and which the owner's words do not reach.
    const ownerWordsOnly =
      Boolean(newSiteUrl) ||
      review.ownComputerAction ||
      (!PRODUCT_PROMPT_TRIGGERS.has(run.trigger) &&
        Boolean(
          lastingWriteKind({ toolName: name, args, savedContextWrite: review.savedContextWrite }),
        ));
    const redacted = redactToolArgsForReview(args, ctx.secrets);
    // Targets come from the whole call: an edit's changes list addresses it removes or keeps too.
    const targetArgs = newSiteUrl
      ? { url: redactSecrets(newSiteUrl, ctx.secrets) }
      : review.ownComputerAction
        ? ownComputerReviewArgs(
            name,
            redacted,
            review.pageUrl && redactSecrets(review.pageUrl, ctx.secrets),
          )
        : redacted;
    const reviewArgs =
      targetArgs === redacted
        ? changedTextReviewArgs(name, redacted, await currentRoutinePrompt(ctx, name, args))
        : targetArgs;
    const reviewRequest: AutoReviewRequest = {
      toolName: name,
      connectorKind,
      args: reviewArgs,
      userTask: redactSecrets(
        outsideRun ? ownerWords : ownerWordsOnly ? await ctx.trust.loadOwnerWords() : userTask,
        ctx.secrets,
      ),
      botDescription,
      matchingRules: review.matchingRules,
      ...(newSiteUrl ? { newSite: true } : {}),
      ...(review.savedContextWrite ? { savedContextWrite: true } : {}),
      ...(review.ownComputerAction ? { ownComputerAction: true } : {}),
      ...(await reviewOwnerContext(ctx, targetArgs, !newSiteUrl && !review.savedContextWrite)),
    };
    // The usage names the reviewed action, so a run's reviews are counted and priced one by one.
    const operationId = applied
      ? `auto-review:${runId}:${applied.effect.id}`
      : `auto-review:${runId}`;
    const reviewContext: AdapterContext = {
      operationId,
      traceId: `auto-review:${runId}`,
      spaceId: run.spaceId,
      userId: run.userId,
      botId: bot.id,
      runId,
      signal: context.signal,
    };
    const checkerProvider = (candidate: AutoReviewCandidate) =>
      autoReviewCheckerProvider(
        deps,
        {
          runId,
          spaceId: run.spaceId,
          userId: run.userId,
          botId: bot.id,
          threadId: thread.id,
          operationId,
        },
        {
          injectedReview,
          memberChecker: candidate.role !== "default",
          registerSecrets: (values) => ctx.secrets.push(...values),
        },
        candidate,
      );
    // The fallback is extra: failing to look it up must not keep the chosen checkers from running.
    const included = injectedReview
      ? null
      : await bestEffort("auto_review.included_checker", includedAutoReviewChecker(deps));
    const includedIsPrimary =
      included &&
      checker &&
      !memberChecker &&
      checker.provider === included.provider &&
      checker.model === included.model &&
      !checker.credentialId &&
      !checker.creditOfferingId;
    const judge = await reviewWithBackups(
      [
        ...(checker
          ? [{ ...checker, role: memberChecker ? ("member" as const) : ("default" as const) }]
          : injectedReview
            ? [{ provider: "injected", model: "injected", role: "default" as const }]
            : []),
        ...(reviewSettings?.backups.map((choice) => ({
          provider: choice.provider,
          model: choice.modelId,
          thinkingLevel: choice.thinkingLevel,
          credentialId: choice.credentialId,
          creditOfferingId: choice.creditOfferingId,
          role: "backup" as const,
        })) ?? []),
        // A member's unusable choice falls back to the deployment's included reviewer.
        ...(included && !includedIsPrimary ? [{ ...included, role: "default" as const }] : []),
      ],
      async (checker) => {
        const provider = await checkerProvider(checker);
        return provider.review(reviewRequest, reviewContext);
      },
      context.signal,
    );
    if (context.signal.aborted) return;
    const verdict = {
      reason: judge.reason,
      decision: applyJudgeDecision({ decision: judge.decision, consequential: gated }),
    };
    if (applied) {
      await deps.prisma.externalEffect.update({
        where: { id: applied.effect.id },
        data: {
          reviewDecision: judge.decision,
          reviewReason: judge.reason,
          reviewModel: judge.model,
        },
      });
    }
    await auditAutoReview(ctx, name, applied, judge.decision, judge.model);
    return verdict;
  } catch {
    // Cancellation must not write a review the next attempt would reuse.
    if (context.signal.aborted) return;
    // Auth/refresh failures must fail closed like a checker error, not fail the run.
    const reviewReason = "Checker could not authenticate.";
    const verdict = {
      reason: reviewReason,
      decision: applyJudgeDecision({ decision: "error", consequential: gated }),
    };
    const reviewModel = checker
      ? `${checker.provider}/${checker.model}`
      : (injectedReview?.describe().id ?? "auto-review");
    if (applied) {
      await deps.prisma.externalEffect.update({
        where: { id: applied.effect.id },
        data: { reviewDecision: "error", reviewReason, reviewModel },
      });
    }
    await auditAutoReview(ctx, name, applied, "error", reviewModel);
    return verdict;
  }
}

function auditAutoReview(
  ctx: RunContext,
  tool: string,
  applied: AppliedEffect | undefined,
  decision: string,
  model: string | undefined,
): Promise<void> {
  return auditToolCall(
    ctx,
    tool,
    decision === "error" ? "failure" : "success",
    { effectId: applied?.effect.id, decision },
    { action: "approval.auto_reviewed", actor: { type: "system", label: model } },
  );
}
