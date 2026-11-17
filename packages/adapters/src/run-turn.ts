import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { isBackgroundRunTrigger, redactSecrets, redactSecretsAfter } from "@rakazo/core";
import { RunHistoryWriteError, recordUsage } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { snapshotReply } from "./reply-snapshot.js";
import type { RunContext } from "./run-context.js";
import { saveTurnCheckpoint } from "./run-context.js";
import { requeueComputerRun, requeueInterruptedRun } from "./run-lifecycle.js";
import { publishMessage } from "./run-messages.js";
import { subagentMarksUnread } from "./run-notifications.js";
import {
  canPublishDurableNarration,
  flushProgress,
  mayBeSilentEnding,
  narrationBecomesMessages,
  progressHeldForSilence,
  publishInterimMessage,
  publishMidTurnNarration,
  recordExplicitNoResponse,
  showNarrationStatus,
  tryFlushPendingTools,
} from "./run-progress.js";
import { pauseForAnswer, pauseForTakeover } from "./run-turn-pause.js";
import { onToolCalled } from "./run-turn-tools.js";
import { withRuntimeCleanup } from "./runtime-stream.js";
import { isStrategicInitiativeRun } from "./strategic-initiative.js";
import { takeoverCheckpointOf } from "./takeover-resume.js";
import {
  assistantTurnSeparator,
  extractNarrationText,
  STEERING_RESET_MIN_GAP_MS,
  STEERING_RESETS_MAX_PER_RUN,
  USER_PROGRESS_MESSAGE_MAX_LENGTH,
} from "./user-progress.js";

export type RuntimeEvent<T extends AgentRuntimeEvent["type"]> = Extract<
  AgentRuntimeEvent,
  { type: T }
>;

/**
 * Stream the runtime's events into the thread. Returns true when the attempt stopped before
 * the turn ended: it paused for an answer, approval or takeover, lost its lease, or was
 * stopped by the tool loop guard.
 */
export async function consumeRunEvents(
  ctx: RunContext,
  events: AsyncIterable<AgentRuntimeEvent>,
): Promise<boolean> {
  const { deps, run, runId, bot } = ctx;
  const { reply } = ctx.state;
  let thinking = false;
  const publishThinking = async (active: boolean) => {
    if (thinking === active) return;
    thinking = active;
    if (ctx.scripted || isBackgroundRunTrigger(run.trigger)) return;
    try {
      await deps.events.append({
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: bot.id,
        runId,
        type: "thread.meta",
        lease: { owner: ctx.workerId, fence: ctx.fence },
        payload: { activity: { thinking: active } },
      });
    } catch (error) {
      // Cancellation and a superseded attempt own their subsequent lifecycle.
      // A stale marker must never override the current worker's state.
      if (!(error instanceof RunHistoryWriteError)) throw error;
    }
  };
  // A quiet model call or a long tool streams no events, so Stop would otherwise go unseen
  // until the next event or heartbeat. The shared throttle keeps this at one read a second.
  let watching = true;
  const watch = setInterval(() => {
    void runLeaseLost(ctx, () => watching)
      .then((lost) => {
        // A read still in flight when the turn ended must not cancel the work that follows it.
        if (lost && watching) ctx.abortController.abort();
      })
      .catch(() => {});
  }, 1_000);
  watch.unref?.();
  try {
    for await (const event of withRuntimeCleanup(events, ctx.abortController)) {
      if (ctx.state.approval.pausePending) return true;
      if (!ctx.state.lease.valid) return true;
      if (await runLeaseLost(ctx)) return true;

      if (
        isStrategicInitiativeRun(run) &&
        (event.type === "takeover" || event.type === "subagent")
      ) {
        throw new Error("Daily check-ins cannot start a computer or helper.");
      }
      if (event.type === "thinking") {
        await publishThinking(event.active);
        continue;
      }
      if (
        (event.type === "text" && event.text.length > 0) ||
        event.type === "tool" ||
        event.type === "progress" ||
        event.type === "ask" ||
        event.type === "takeover" ||
        event.type === "turn" ||
        event.type === "done"
      )
        await publishThinking(false);

      // Check complete assistant turns so split sentinel chunks are recognized
      // without treating a partial identifier (NO_RESPONSE_POLICY) as silence.
      if (event.type === "tool" || event.type === "takeover") {
        recordExplicitNoResponse(reply, reply.assistantTurnText);
        reply.assistantTurnText = "";
      }
      if (event.type === "text") {
        await streamText(ctx, event);
      } else if (event.type === "turn") {
        reply.assistantTurnBreakPending = true;
      } else if (event.type === "steered") {
        await onSteered(ctx, event);
      } else if (event.type === "progress") {
        await streamProgress(ctx, event);
      } else if (event.type === "ask") {
        await pauseForAnswer(ctx, event);
        return true;
      } else if (event.type === "takeover") {
        await pauseForTakeover(ctx, event);
        return true;
      } else if (event.type === "tool") {
        if (await onToolCalled(ctx, event)) return true;
      } else if (event.type === "yielded") {
        const ended = await handBackBetweenSteps(ctx, event.checkpoint);
        event.answer(ended);
        if (ended) return true;
      } else if (event.type === "subagent") {
        await publishSubagent(ctx, event);
      } else if (event.type === "usage" && !event.accounted) {
        await recordUsage(deps.prisma, event, {
          spaceId: run.spaceId,
          botId: bot.id,
          userId: run.userId,
          runId,
          parentRunId: runId,
          operationId: runId,
        });
      } else if (event.type === "done") {
        recordExplicitNoResponse(reply, event.text ?? "");
        if (!reply.assembled && event.text) {
          if (reply.publishedMidTurnUserMessage || reply.discardedMidTurnNarration) {
            // Mid-turn narration was already published or discarded (routines).
            // Post-tool finals are streamed into assembled; do not restore
            // cumulative done.text (clamp/redaction make substring stripping brittle).
          } else {
            reply.assembled = event.text;
            reply.currentTextSegment += event.text;
          }
        }
      }
    }
    return false;
  } finally {
    watching = false;
    clearInterval(watch);
    // Run completion clears thinking too; never let this replace the turn's own outcome.
    await publishThinking(false).catch(() => {});
  }
}

/**
 * At most once a second, check the run is still this attempt's and not cancelled or released.
 * A read that answers after `active` turns false acts on nothing.
 */
async function runLeaseLost(ctx: RunContext, active = () => true) {
  const { deps, runId, workerId, fence } = ctx;
  const { lease } = ctx.state;
  const now = Date.now();
  if (now - lease.lastCheckAt < 1_000) return false;
  lease.lastCheckAt = now;
  const still = await deps.prisma.run.findUnique({
    where: { id: runId },
    select: { status: true, leaseOwner: true, leaseFence: true, checkpoint: true },
  });
  if (!active()) return false;
  if (!still || still.status === "cancelled" || still.leaseOwner !== workerId) {
    lease.valid = false;
    return true;
  }
  if (still.leaseFence !== fence) {
    // A newer attempt of this run recovered it in this process (same worker, new
    // fence): only this attempt's writes must stop, the run's state stays.
    lease.valid = false;
    return true;
  }
  const releasedHold = takeoverCheckpointOf(still.checkpoint);
  if (ctx.computer.heldForTakeover && releasedHold) {
    await requeueComputerRun(deps, runId, workerId, fence, releasedHold, false);
    lease.valid = false;
    if (active()) ctx.abortController.abort();
    return true;
  }
  return false;
}

async function streamText(ctx: RunContext, event: RuntimeEvent<"text">) {
  const { reply } = ctx.state;
  reply.assistantTurnText += event.text;
  if (event.text) reply.narrationStatusShowing = false;
  reply.textSinceLastStep += event.text;
  if (reply.assistantTurnBreakPending && event.text) {
    reply.assistantTurnBreakPending = false;
    const separator = assistantTurnSeparator(reply.assembled, event.text);
    if (separator) {
      reply.assembled += separator;
      reply.currentTextSegment += separator;
      reply.pendingProgress += reply.redactor.push(separator);
    }
  }
  reply.assembled += event.text;
  reply.currentTextSegment += event.text;
  ctx.state.toolCallStreak = { key: undefined, count: 0 };
  tryFlushPendingTools(reply);
  reply.pendingProgress += reply.redactor.push(event.text);
  const now = Date.now();
  if (!ctx.scripted && reply.pendingProgress && now - reply.lastProgressAt >= 250) {
    await flushProgress(ctx);
  }
}

async function streamProgress(ctx: RunContext, event: RuntimeEvent<"progress">) {
  const { deps, run, runId, bot, thread } = ctx;
  const { reply } = ctx.state;
  // Tool status lines are not the model writing.
  if (!event.activity) ctx.state.toolCallStreak = { key: undefined, count: 0 };
  if (run.trigger === "routine" || isBackgroundRunTrigger(run.trigger)) return;
  // The bot's own note stays the working line until it writes again.
  if (event.activity && reply.narrationStatusShowing) return;
  // Flush batched text deltas first so an activity line cannot land
  // ahead of text the model streamed before the tool call.
  if (reply.pendingProgress && !progressHeldForSilence(ctx)) {
    await deps.events.append({
      spaceId: run.spaceId,
      threadId: thread.id,
      botId: bot.id,
      type: "thread.progress",
      runId,
      payload: { delta: reply.pendingProgress, streaming: true },
    });
    reply.pendingProgress = "";
    reply.lastProgressAt = Date.now();
  }
  await deps.events.append({
    spaceId: run.spaceId,
    threadId: thread.id,
    botId: bot.id,
    type: "thread.progress",
    runId,
    payload: {
      text: redactSecrets(event.text, ctx.secrets),
      ...(event.activity ? { activity: true } : {}),
    },
  });
}

/**
 * The run's person wrote while the bot worked: the next note may answer them at once, each time.
 * The budget restart for unprompted updates stays capped. Webhooks, external chats and other
 * members stay on the normal budget.
 */
async function onSteered(ctx: RunContext, event: RuntimeEvent<"steered">) {
  const { reply } = ctx.state;
  reply.assistantTurnBreakPending = true;
  if (ctx.replyMode === "messages") {
    await flushProgress(ctx);
    await showNarrationStatus(ctx, await publishMidTurnNarration(ctx));
  }
  if (!event.fromRunUser) return;
  const now = Date.now();
  if (
    reply.steeringResets >= STEERING_RESETS_MAX_PER_RUN ||
    now - reply.lastSteeringResetAt < STEERING_RESET_MIN_GAP_MS
  ) {
    // What the bot wrote before may still use an earlier message's allowance. If it can't be
    // posted now, it stays in the reply.
    await flushProgress(ctx);
    const before = extractNarrationText(reply.messageSegments, reply.currentTextSegment).text;
    const text = redactSecretsAfter(reply.narrationSoFar, before, ctx.secrets).trim();
    if (
      text.length <= USER_PROGRESS_MESSAGE_MAX_LENGTH &&
      canPublishDurableNarration(ctx) &&
      !mayBeSilentEnding(ctx, text)
    )
      await publishMidTurnNarration(ctx);
    reply.steeringReplyPending = true;
    return;
  }
  reply.steeringResets += 1;
  reply.lastSteeringResetAt = now;
  await flushProgress(ctx);
  const before = extractNarrationText(reply.messageSegments, reply.currentTextSegment);
  const text = redactSecretsAfter(reply.narrationSoFar, before.text, ctx.secrets).trim();
  if (text && narrationBecomesMessages(ctx) && !mayBeSilentEnding(ctx, text)) {
    reply.narrationSoFar += before.text;
    reply.messageSegments = before.remaining;
    reply.currentTextSegment = "";
    reply.workingNotes.length = 0;
    reply.assembled = "";
    reply.hasStreamedText = false;
    reply.pendingProgress = "";
    reply.redactor.skip();
    await publishInterimMessage(ctx, text);
  }
  reply.progressBudgetStart = reply.midTurnProgressCount;
  reply.turnStartedAtMs = now;
  reply.steeringReplyPending = true;
  reply.narrationStatusShowing = false;
}

/**
 * The process is stopping and the turn finished a step: keep its narration, save the turn and
 * queue the run, so another process resumes with the next model call instead of repeating one.
 * Returns whether the turn ends here; when any part fails the turn goes on in this process, and
 * the shutdown path hands it back if it is still running at the drain limit.
 */
async function handBackBetweenSteps(ctx: RunContext, checkpoint: string): Promise<boolean> {
  const { deps, runId, workerId, fence } = ctx;
  const ended = await bestEffort(
    "run.hand_back",
    (async () => {
      await publishMidTurnNarration(ctx);
      // Saved before the flush, so a shutdown that cuts the flush short still resumes after
      // this step.
      await saveTurnCheckpoint(ctx, checkpoint, snapshotReply(ctx.state.reply));
      await ctx.computer.checkpoint.flush();
      ctx.state.lease.handedBack = await requeueInterruptedRun(deps, runId, workerId, fence);
      return true;
    })(),
  );
  return ended ?? false;
}

async function publishSubagent(ctx: RunContext, event: RuntimeEvent<"subagent">) {
  const { deps, run, runId, bot, thread } = ctx;
  const { reply, runningHelpers } = ctx.state;
  const safeTask = redactSecrets(event.task, ctx.secrets);
  const safeProgress = event.progress ? redactSecrets(event.progress, ctx.secrets) : undefined;
  const safeResult = event.result ? redactSecrets(event.result, ctx.secrets) : undefined;
  await deps.events.append({
    spaceId: run.spaceId,
    threadId: thread.id,
    botId: bot.id,
    type: "thread.subagent",
    runId,
    payload: {
      agentId: event.agentId,
      name: event.name,
      task: safeTask,
      status: event.status,
      progress: safeProgress,
      result: safeResult,
    },
  });
  if (event.status === "running") {
    runningHelpers.set(event.agentId, {
      agentId: event.agentId,
      name: event.name,
      task: safeTask,
      status: event.status,
      progress: safeProgress,
    });
  } else {
    runningHelpers.delete(event.agentId);
  }
  if (event.status === "completed" || event.status === "failed") {
    const repliesToRequest = ctx.source.peerMessage?.repliesToRequest === true;
    reply.publishedTerminalSubagent ||= !subagentMarksUnread(
      run.trigger,
      event.status,
      repliesToRequest,
    );
    await publishMessage(
      deps,
      run,
      "bot",
      [
        {
          kind: "subagent",
          agentId: event.agentId,
          name: event.name,
          task: safeTask,
          status: event.status,
          progress: safeProgress,
          result: safeResult,
        },
      ],
      subagentMarksUnread(run.trigger, event.status, repliesToRequest),
    );
  }
}
