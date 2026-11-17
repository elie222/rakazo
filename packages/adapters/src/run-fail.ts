import {
  ModelAccountError,
  ModelOutputError,
  SandboxAllowanceUsedError,
  SandboxProviderAccountError,
  SandboxRateLimitError,
  TransientModelError,
} from "@rakazo/adapter-kit";
import {
  BACKGROUND_HELPER_TRIGGER,
  containsSecret,
  displayName,
  MISSING_TOOL_FINAL_RESPONSE_ERROR,
  normalizeRunError,
  redactSecrets,
  userRunError,
} from "@rakazo/core";
import { isDatabaseUnavailable, retryWhileDatabaseUnavailable } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { sanitizedError } from "@rakazo/logging/monitoring";
import { returnHelperOutcome } from "./background-helpers.js";
import { returnBotMessageOutcome } from "./bot-messages.js";
import { rejectedRequestsOf } from "./provider-request-shape.js";
import { backOffRoutineAfterAccountError, modelAccountRefusal } from "./routine-backoff.js";
import type { RunContext, RunState } from "./run-context.js";
import {
  computerRetryDelay,
  enqueueSteeringContinuation,
  requeueInterruptedRun,
} from "./run-lifecycle.js";
import { notifyRun, runSendsFinishNotification } from "./run-notifications.js";
import { recordExplicitNoResponse } from "./run-progress.js";
import { runPromotesMidTurnNarration } from "./run-replies.prompt.js";
import { scheduleRoutineRetry } from "./run-routines.js";
import { isStrategicInitiativeRun } from "./strategic-initiative.js";
import { extractNarrationText } from "./user-progress.js";

/** A group handoff already gave the work to another member, so the turn needs no reply. */
export function handoffEndedTurn(state: Pick<RunState, "handedOff">, error: unknown): boolean {
  return (
    state.handedOff &&
    error instanceof ModelOutputError &&
    error.message === MISSING_TOOL_FINAL_RESPONSE_ERROR
  );
}

/**
 * Groups failures by provider and the kind and status the provider reported, never by message
 * text, which quotes ids and user content.
 */
function runFailureFingerprint(provider: string, message: string): string[] {
  const { kind, status } = normalizeRunError(message);
  return ["run.failed", provider || "unknown", kind ?? "unclassified", String(status ?? "none")];
}

/** The shape of a request the provider rejected for a reason nothing classified. */
function requestDetails(error: unknown): { "error.details"?: string } {
  const rejected = rejectedRequestsOf(error);
  return rejected ? { "error.details": JSON.stringify({ providerRequests: rejected }) } : {};
}

/**
 * The database went away mid-turn, which is no fault of the turn. Once the database answers
 * again, hand the run back as a stopping worker does, keeping its turn on the computer; it
 * starts again here and resumes. Its fence spaces out repeats, so a database that is only
 * saturated is not hammered. An outage longer than the wait leaves the run to lease expiry.
 */
export async function requeueRunAfterDatabaseOutage(ctx: RunContext): Promise<void> {
  const { deps, runId, workerId, fence } = ctx;
  if (!ctx.state.terminalCheckpointComplete) {
    await ctx.computer.checkpoint.flush().catch(() => undefined);
  }
  const wakeAt = new Date(Date.now() + computerRetryDelay(fence));
  try {
    ctx.state.lease.handedBack = await retryWhileDatabaseUnavailable(
      () => requeueInterruptedRun(deps, runId, workerId, fence, wakeAt),
      { source: "run requeue", signal: deps.shutdownSignal },
    );
  } catch (error) {
    if (!isDatabaseUnavailable(error)) throw error;
  }
}

/** The turn failed: keep the reply streamed so far, record the error, and retry or notify. */
export async function failRun(
  ctx: RunContext,
  caughtError: unknown,
  model: {
    /** The run used the deployment's own model key. */
    ownCredential: boolean | undefined;
    active: Record<"model.provider" | "model.id", string>;
  },
) {
  const { deps, run, runId, bot, thread } = ctx;
  const { reply } = ctx.state;
  let error = caughtError;
  // A refused account limit needs user/operator action, not setup-job retries.
  // Keep the provisioning error even if aborting the model masked it.
  try {
    ctx.computer.lazy.throwIfFailed();
  } catch (computerError) {
    if (
      !(computerError instanceof SandboxRateLimitError) &&
      !(computerError instanceof SandboxAllowanceUsedError) &&
      !(computerError instanceof SandboxProviderAccountError)
    )
      throw computerError;
    error = computerError;
  }
  if (!ctx.state.terminalCheckpointComplete) {
    await ctx.computer.checkpoint.flush().catch(() => undefined);
  }
  const message = redactSecrets(userRunError(error), ctx.secrets);
  // Reply text the user watched stream in since the last saved message stays in the
  // thread, above the error, instead of vanishing with the live row.
  recordExplicitNoResponse(reply, reply.assistantTurnText);
  const partialText =
    ctx.scripted ||
    ctx.state.handedOff ||
    reply.explicitNoResponse ||
    !runPromotesMidTurnNarration(run.trigger)
      ? ""
      : redactSecrets(
          extractNarrationText(reply.messageSegments, reply.currentTextSegment).text,
          ctx.secrets,
        ).trim();
  const partialReply =
    partialText && !containsSecret(partialText, ctx.secrets)
      ? [{ kind: "text" as const, text: partialText }]
      : [];
  await ctx.settleRunningHelpers();
  const failed = await deps.events.finalizeRun({
    spaceId: run.spaceId,
    threadId: thread.id,
    botId: bot.id,
    runId,
    taskId: run.taskId,
    attemptId: ctx.attempt.id,
    leaseOwner: ctx.workerId,
    leaseFence: ctx.fence,
    outcome: "failed",
    error: message,
    ...(partialReply.length > 0 ? { partialReply } : {}),
  });
  if (!failed) return;
  if (
    error instanceof TransientModelError ||
    error instanceof ModelAccountError ||
    error instanceof ModelOutputError ||
    error instanceof SandboxRateLimitError ||
    error instanceof SandboxAllowanceUsedError
  ) {
    // Provider outages that outlasted retries, provider accounts, plans and model
    // choices the user fixes, unusable model output, the computer provider's own rate limit
    // and a spent computer allowance are not server faults; the run error tells the user.
    getLogger().warn("run.failed", {
      "run.outcome": "failed",
      "run.failure": error.name,
      reason: message,
      ...model.active,
    });
  } else {
    getLogger().error(
      "run.failed",
      sanitizedError(error, (text) => redactSecrets(text, ctx.secrets)),
      {
        "run.outcome": "failed",
        ...model.active,
        "error.fingerprint": runFailureFingerprint(model.active["model.provider"], message),
        ...requestDetails(error),
      },
    );
  }
  await enqueueSteeringContinuation(deps, failed.continuationRunId);
  if (run.trigger === "bot_message") {
    await returnBotMessageOutcome(
      deps,
      { ...run, sourceMessageId: run.sourceMessageId },
      { id: bot.id, name: bot.name },
      `Could not complete the delegated request: ${message}`,
      "status",
      { forceUnread: true },
    ).catch((returnError) => getLogger().error("bot message failure return", returnError));
  }
  if (run.trigger === BACKGROUND_HELPER_TRIGGER) {
    await returnHelperOutcome(deps, run, { status: "failed", text: message }).catch((returnError) =>
      getLogger().error("background helper failure return", returnError),
    );
  }
  // A refusal of the deployment's own key is the operator's problem, not the user's.
  const refusal =
    run.trigger === "routine" && model.ownCredential ? modelAccountRefusal(error) : undefined;
  // A spent computer allowance or an unusable provider account refuses every run that needs the
  // computer until someone fixes it.
  if (
    run.trigger === "routine" &&
    run.routineId &&
    (refusal ||
      error instanceof SandboxAllowanceUsedError ||
      error instanceof SandboxProviderAccountError)
  ) {
    await backOffRoutineAfterAccountError(
      deps,
      { routineId: run.routineId, userId: run.userId },
      new Date(),
      refusal?.resetAt,
    );
  }
  const retrying = !failed.continuationRunId && (await scheduleRoutineRetry(deps, run, error));
  // Nobody asked for a check-in, so its failure is not news to the user.
  if (
    runSendsFinishNotification(run.trigger) &&
    !isStrategicInitiativeRun(run) &&
    !failed.continuationRunId &&
    !retrying
  ) {
    await notifyRun(deps, run, {
      kind: "failure",
      title: `${displayName(bot.name, "Bot")} failed`,
      body: message,
      botId: bot.id,
      threadId: thread.id,
    });
  }
}
