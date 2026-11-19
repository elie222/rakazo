import { humanizeToolName, isBackgroundRunTrigger } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { isToolPauseResult } from "../../approvals/approval-effect.js";
import { returnBotMessageOutcome } from "../../messaging/bot-messages.js";
import { clearRoutineBackoff } from "../../routines/routine-backoff.js";
import { connectorStepNames } from "../../runtime/pi/tools/pi-runtime-tools.js";
import type { RunContext } from "../assembly/run-context.js";
import { publishMessage, redactBlocks } from "../assembly/run-messages.js";
import {
  conversationRetentionMessages,
  enqueueConversationRetention,
} from "../lifecycle/run-complete.js";
import { enqueueSteeringContinuation, renewRunLease } from "../lifecycle/run-lifecycle.js";
import {
  flushPendingTools,
  flushProgress,
  publishMidTurnNarration,
  showNarrationStatus,
  tryFlushPendingTools,
  withReplyToolOutcomes,
} from "../lifecycle/run-progress.js";
import { applyTool } from "../tools/run-tools.js";
import type { RuntimeEvent } from "./run-turn.js";
import {
  appendToolCompletionAudit,
  logLoopGuardStop,
  toolCompletionFromResult,
  toolCompletionOutcome,
} from "./tool-completion-audit.js";
import {
  advanceOverLimitActionCalls,
  advanceToolCallLoopGuard,
  loopGuardStop,
  loopGuardStopText,
  MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS,
  overLimitStopText,
  toolResultFingerprint,
} from "./tool-loop.js";
import type { ToolRefusal } from "./tool-refusal.js";
import {
  keepToolStepResult,
  keptToolArguments,
  saveLatestStepScreenshot,
} from "./tool-step-calls.js";

function showToolStep(ctx: RunContext, event: RuntimeEvent<"tool">) {
  const { reply } = ctx.state;
  // Queued first so the text written before this call becomes its note.
  const stepNames = connectorStepNames(ctx.tools.connector.get(event.name), event.args);
  const callSteps = stepNames.length > 0 ? stepNames : [event.name];
  reply.pendingToolNames.push(...callSteps);
  // A call that shows as its own step keeps what it was called with, for later turns to replay.
  const ownStep = callSteps.length === 1 && callSteps[0] === event.name;
  const early = reply.earlyCompletions?.get(event.executionId);
  reply.earlyCompletions?.delete(event.executionId);
  if (ownStep) {
    reply.toolStepCalls.set(event.executionId, {
      arguments: keptToolArguments(event.args, ctx.secrets),
    });
    if (early) keepToolStepResult(reply, early, ctx.secrets);
  }
  reply.toolCalls.push(
    ...callSteps.map((name) => ({
      label: humanizeToolName(name),
      executionId: event.executionId,
      ...(ownStep ? { tool: event.name } : {}),
    })),
  );
}

/** Show the tool step, stop a repeating loop, and run the tool for scripted runtimes. */
export async function onToolCalled(ctx: RunContext, event: RuntimeEvent<"tool">): Promise<boolean> {
  const { deps, run, runId, bot, thread } = ctx;
  const { reply } = ctx.state;
  // Preserve event ordering when the throttle still holds recent narration: the
  // client must see that text before the tool call it describes.
  await flushProgress(ctx);
  // The call a paused turn resumes on already shows as a step in the reply it saved.
  if (!reply.toolCalls.some((call) => call.executionId === event.executionId))
    showToolStep(ctx, event);
  // Text before ask_user stays pending: the run pauses next, and the question needs it.
  const heldNote =
    event.name === "message_user" || event.name === "ask_user"
      ? undefined
      : await publishMidTurnNarration(ctx);
  // A step without a note of its own replaces the earlier one in the live view, so its status
  // lines show again.
  if (!heldNote) reply.narrationStatusShowing = false;
  reply.textSinceLastStep = "";
  reply.assistantTurnBreakPending = true;
  await deps.events.append({
    spaceId: run.spaceId,
    threadId: thread.id,
    botId: bot.id,
    type: "agent.tool.called",
    runId,
    payload: { name: event.name, executionId: event.executionId },
  });
  await showNarrationStatus(ctx, heldNote);
  tryFlushPendingTools(reply);
  // A call can finish before or after its own event is handled, so its result is read here.
  const { toolCallStreak: streak, toolResults } = ctx.state;
  const previousResult = streak.executionId ? toolResults.get(streak.executionId) : undefined;
  const loopGuard = advanceToolCallLoopGuard(
    streak,
    event.name,
    event.args,
    previousResult,
    event.response,
  );
  // The refusal the previous call of the streak got, read before this call can add its own.
  const previousRefusal = streak.executionId
    ? ctx.state.toolRefusals?.get(streak.executionId)
    : undefined;
  // A call from the same response as the streak's last one leaves it as it was.
  if (loopGuard.streak !== streak) {
    if (streak.executionId) {
      toolResults.delete(streak.executionId);
      ctx.state.toolRefusals?.delete(streak.executionId);
    }
    ctx.state.toolCallStreak = { ...loopGuard.streak, executionId: event.executionId };
  }
  ctx.state.overLimitActionCalls = advanceOverLimitActionCalls(
    ctx.state.overLimitActionCalls,
    event.name,
    event.args,
  );
  if (
    loopGuard.stuck ||
    ctx.state.overLimitActionCalls >= MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS
  ) {
    // An action-limit stop is not about the previous call, which may be another tool's.
    await stopStuckToolLoop(ctx, event.name, loopGuard.stuck ? previousRefusal : undefined);
    return true;
  }
  if (!ctx.scripted) return false;
  const startedAt = Date.now();
  const audit = { spaceId: run.spaceId, threadId: thread.id, botId: bot.id, runId };
  try {
    const result = await applyTool(ctx, event.name, event.args, event.executionId);
    toolResults.set(event.executionId, toolResultFingerprint(result));
    const completion = toolCompletionFromResult(
      { name: event.name, executionId: event.executionId, durationMs: Date.now() - startedAt },
      result,
    );
    const outcome = toolCompletionOutcome(completion);
    if (outcome) reply.toolOutcomes.set(event.executionId, outcome);
    keepToolStepResult(reply, completion, ctx.secrets);
    await appendToolCompletionAudit(deps, audit, completion, ctx.secrets);
    return isToolPauseResult(result);
  } catch (error) {
    reply.toolOutcomes.set(event.executionId, "failed");
    await appendToolCompletionAudit(
      deps,
      audit,
      {
        name: event.name,
        executionId: event.executionId,
        durationMs: Date.now() - startedAt,
        error,
      },
      ctx.secrets,
    );
    throw error;
  }
}

/** The model keeps repeating the same call: finish the run with what it has and say why. */
async function stopStuckToolLoop(ctx: RunContext, toolName: string, refusal?: ToolRefusal) {
  const { deps, run, runId, bot, thread, workerId, fence } = ctx;
  const { reply } = ctx.state;
  // Otherwise the model keeps calling tools while the stop is saved. The run's own signal stays
  // live, so the save still finishes.
  ctx.runtimeAbortController.abort();
  ctx.tools.approvedReplays.assertDrained();
  flushPendingTools(reply);
  await saveLatestStepScreenshot(ctx);
  // Calls that had not finished when the loop was stopped never ran to the end.
  reply.messageSegments = withReplyToolOutcomes(reply, "stopped");
  if (!(await renewRunLease(deps, runId, workerId, fence))) return;
  if (reply.messageSegments.length > 0) {
    await publishMessage(deps, run, "bot", redactBlocks(reply.messageSegments, ctx.secrets));
  }
  await ctx.computer.checkpoint.flush();
  ctx.state.terminalCheckpointComplete = true;
  const overLimit = ctx.state.overLimitActionCalls;
  const humanName = humanizeToolName(toolName);
  const stuckText =
    overLimit >= MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS
      ? overLimitStopText(humanName, overLimit)
      : loopGuardStopText(humanName, ctx.state.toolCallStreak);
  await ctx.settleRunningHelpers();
  const answeredMessageIds = await conversationRetentionMessages(ctx);
  const stopped = await deps.events.finalizeRun({
    spaceId: run.spaceId,
    threadId: thread.id,
    botId: bot.id,
    runId,
    taskId: run.taskId,
    attemptId: ctx.attempt.id,
    leaseOwner: workerId,
    leaseFence: fence,
    outcome: "completed",
    blocks: isBackgroundRunTrigger(run.trigger) ? [] : [{ kind: "text", text: stuckText }],
  });
  if (!stopped) return;
  await enqueueConversationRetention(ctx, answeredMessageIds);
  const stoppedForOverLimit = overLimit >= MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS;
  const loop = loopGuardStop(ctx.state.toolCallStreak);
  logLoopGuardStop(
    {
      spaceId: run.spaceId,
      threadId: thread.id,
      botId: bot.id,
      runId,
      trigger: run.trigger,
    },
    {
      tool: toolName,
      reason: stoppedForOverLimit
        ? "over_limit_actions"
        : loop.kind === "same_result"
          ? "repeated_results"
          : "repeated_calls",
      count: stoppedForOverLimit ? overLimit : loop.count,
      failures: ctx.state.toolCallStreak.failures ?? 0,
      ...(refusal ? { refusal } : {}),
    },
    ctx.secrets,
  );
  ctx.stopHeartbeatAfterCompletion();
  if (run.trigger === "routine" && run.routineId) {
    await clearRoutineBackoff(deps, { routineId: run.routineId, userId: run.userId });
  }
  await enqueueSteeringContinuation(deps, stopped.continuationRunId);
  if (run.trigger === "bot_message") {
    await returnBotMessageOutcome(
      deps,
      { ...run, sourceMessageId: run.sourceMessageId },
      { id: bot.id, name: bot.name },
      stuckText,
      "result",
      { forceUnread: true },
    ).catch((error) => getLogger().error("bot message loop-guard return", error));
  }
  ctx.abortController.abort();
}
