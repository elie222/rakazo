import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import {
  DEFAULT_CONTEXT_STRATEGY,
  historyCompactJob,
  ModelAccountError,
  ModelOutputError,
  runContinueJob,
  SandboxRateLimitError,
  TransientModelError,
} from "@rakazo/adapter-kit";
import {
  containsSecret,
  displayName,
  humanizeToolName,
  isBackgroundRunTrigger,
  redactSecrets,
  TAKEOVER_COMPUTER_PENDING_STATE,
  userRunError,
} from "@rakazo/core";
import { recordUsage } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { sanitizedError } from "@rakazo/logging/monitoring";
import { isToolPauseResult } from "./approval-effect.js";
import { returnBotMessageOutcome } from "./bot-messages.js";
import { scheduleComputerSleep } from "./computer-idle.js";
import { holdComputerExecutionLeaseForTakeover } from "./computer-lifecycle.js";
import { resolveBotWorkspacePath } from "./computer-support.js";
import {
  COMPACTION_BATCH_SIZE,
  HISTORY_WINDOW_SIZE,
  shouldEnqueueCompaction,
} from "./history-compaction.js";
import {
  backOffRoutineAfterAccountError,
  clearRoutineBackoff,
  isModelAccountRefusal,
} from "./routine-backoff.js";
import type { RunContext } from "./run-context.js";
import { persistTurnCheckpoint } from "./run-context.js";
import { renewRunLease, requeueComputerRun } from "./run-lifecycle.js";
import { publishMessage, redactBlocks } from "./run-messages.js";
import {
  completionMarksUnread,
  completionNotificationBody,
  completionNotificationPreview,
  notifyRun,
  runSendsFinishNotification,
  subagentMarksUnread,
} from "./run-notifications.js";
import {
  canPublishDurableNarration,
  flushPendingTools,
  flushProgress,
  publishMidTurnNarration,
  recordExplicitNoResponse,
  tryFlushPendingTools,
} from "./run-progress.js";
import {
  completionMessageSegments,
  emptyDelegatedToolTurnShouldFail,
  runAllowsSilentEmpty,
  runPromotesMidTurnNarration,
  TOOL_STEPS_WITHOUT_RESPONSE,
} from "./run-replies.js";
import { scheduleRoutineRetry } from "./run-routines.js";
import { applyTool } from "./run-tools.js";
import { withRuntimeCleanup } from "./runtime-stream.js";
import { stripNoResponseReply, stripStrayNoResponse } from "./silent-reply.js";
import { takeoverCheckpointOf } from "./takeover-resume.js";
import { appendToolCompletionAudit, toolCompletionFromResult } from "./tool-completion-audit.js";
import { advanceToolCallLoopGuard, loopGuardStopText } from "./tool-loop.js";
import {
  assistantTurnSeparator,
  botMessageOutcomeFromMidTurn,
  clampUserProgressMessage,
  extractNarrationText,
  finalBlocksAfterMidTurnProgress,
  userProgressClientNonce,
} from "./user-progress.js";

type RuntimeEvent<T extends AgentRuntimeEvent["type"]> = Extract<AgentRuntimeEvent, { type: T }>;

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
  for await (const event of withRuntimeCleanup(events, ctx.abortController)) {
    if (ctx.state.approval.pausePending) return true;
    if (!ctx.state.lease.valid) return true;
    if (await runLeaseLost(ctx)) return true;

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
}

/** At most once a second, check the run is still this attempt's and not cancelled or released. */
async function runLeaseLost(ctx: RunContext) {
  const { deps, runId, workerId, fence } = ctx;
  const { lease } = ctx.state;
  const now = Date.now();
  if (now - lease.lastCheckAt < 1_000) return false;
  lease.lastCheckAt = now;
  const still = await deps.prisma.run.findUnique({
    where: { id: runId },
    select: { status: true, leaseOwner: true, leaseFence: true, checkpoint: true },
  });
  if (
    !still ||
    still.status === "cancelled" ||
    still.leaseOwner !== workerId ||
    still.leaseFence !== fence
  ) {
    lease.valid = false;
    return true;
  }
  const releasedHold = takeoverCheckpointOf(still.checkpoint);
  if (ctx.computer.heldForTakeover && releasedHold) {
    await requeueComputerRun(deps, runId, workerId, fence, releasedHold, false);
    lease.valid = false;
    ctx.abortController.abort();
    return true;
  }
  return false;
}

async function streamText(ctx: RunContext, event: RuntimeEvent<"text">) {
  const { reply } = ctx.state;
  reply.assistantTurnText += event.text;
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
  ctx.state.toolCallStreak = { key: undefined, count: 0 };
  if (run.trigger === "routine" || isBackgroundRunTrigger(run.trigger)) return;
  // Flush batched text deltas first so an activity line cannot land
  // ahead of text the model streamed before the tool call.
  if (reply.pendingProgress) {
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

async function pauseForAnswer(ctx: RunContext, event: RuntimeEvent<"ask">) {
  const { deps, run, runId, bot, thread, workerId, fence } = ctx;
  if (!(await renewRunLease(deps, runId, workerId, fence))) return;
  const safeText = redactSecrets(event.text, ctx.secrets);
  const safeDetail = event.detail ? redactSecrets(event.detail, ctx.secrets) : event.detail;
  const safeActions = event.actions?.map((action) => ({
    id: action.id,
    label: redactSecrets(action.label, ctx.secrets),
  }));
  await ctx.computer.checkpoint.flush();
  await persistTurnCheckpoint(ctx, event.executionId);
  await ctx.settleRunningHelpers();
  const paused = await deps.events.pauseRunForInput({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    runId,
    attemptId: ctx.attempt.id,
    leaseOwner: workerId,
    leaseFence: fence,
    blocks: [
      {
        kind: "ask",
        text: safeText,
        detail: safeDetail,
        status: "pending",
        actions: safeActions,
      },
    ],
    // Keep unredacted labels on the run for resume; message blocks stay redacted.
    offeredActions: event.actions,
  });
  if (!paused) return;
  if (paused.continuationRunId) {
    await deps.jobs
      .enqueue(runContinueJob(paused.continuationRunId))
      .catch((error) => getLogger().error("steering continuation enqueue", error));
  }
  await notifyRun(deps, run, {
    kind: "help",
    title: `${displayName(bot.name, "Bot")} needs an answer`,
    body: safeText,
    botId: bot.id,
    threadId: thread.id,
  });
}

async function pauseForTakeover(ctx: RunContext, event: RuntimeEvent<"takeover">) {
  const { deps, run, runId, bot, thread, workerId, fence } = ctx;
  const { reply } = ctx.state;
  if (!(await renewRunLease(deps, runId, workerId, fence))) return;
  // The user takes over the computer's screen, so it must be up before the run waits.
  await ctx.computer.get("takeover");
  const safeReason = redactSecrets(event.reason, ctx.secrets);
  // Publish pending narration as tagged mid-turn progress so reconciliation
  // does not treat pre-takeover text as the delegated final result.
  await publishMidTurnNarration(ctx);
  if (reply.assembled.trim()) {
    const narration = clampUserProgressMessage(redactSecrets(reply.assembled, ctx.secrets));
    if (narration && canPublishDurableNarration(ctx)) {
      await publishMessage(
        deps,
        run,
        "bot",
        [{ kind: "text", text: narration }],
        undefined,
        userProgressClientNonce(run.id, reply.midTurnProgressCount++),
      );
      reply.midTurnUserTexts.push(narration);
      reply.publishedMidTurnUserMessage = true;
    } else if (narration) {
      reply.discardedMidTurnNarration = true;
      reply.lastDiscardedMidTurnNarration = narration;
    }
    reply.assembled = "";
    reply.hasStreamedText = false;
    reply.pendingProgress = "";
  }
  // Give the user a full idle period to answer before the computer may suspend.
  scheduleComputerSleep(deps.jobs, ctx.computer.stored.id);
  await publishMessage(
    deps,
    run,
    "bot",
    [{ kind: "computer", state: TAKEOVER_COMPUTER_PENDING_STATE, text: safeReason }],
    true,
  );
  await ctx.computer.checkpoint.flush();
  if (!(await holdComputerExecutionLeaseForTakeover(deps.prisma, ctx.computer.lease))) {
    throw new Error("Computer lease expired before takeover");
  }
  await persistTurnCheckpoint(ctx, event.executionId);
  await ctx.settleRunningHelpers();
  const paused = await deps.events.pauseRunForTakeover({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    runId,
    attemptId: ctx.attempt.id,
    leaseOwner: workerId,
    leaseFence: fence,
    reason: safeReason,
    computerId: ctx.computer.stored.id,
  });
  if (!paused) return;
  ctx.state.lease.retainComputer = true;
  await notifyRun(deps, run, {
    kind: "takeover",
    title: `${displayName(bot.name, "Bot")} needs you on the screen`,
    body: safeReason,
    botId: bot.id,
    threadId: thread.id,
  });
}

/** Show the tool step, stop a repeating loop, and run the tool for scripted runtimes. */
async function onToolCalled(ctx: RunContext, event: RuntimeEvent<"tool">): Promise<boolean> {
  const { deps, run, runId, bot, thread } = ctx;
  const { reply } = ctx.state;
  // Preserve event ordering when the throttle still holds recent narration: the
  // client must see that text before the tool call it describes.
  await flushProgress(ctx);
  // Promote streamed narration into a durable, replyable chat message before
  // tools continue, so long turns do not look stalled and stay replyable.
  if (event.name !== "message_user") {
    await publishMidTurnNarration(ctx);
  }
  reply.assistantTurnBreakPending = true;
  await deps.events.append({
    spaceId: run.spaceId,
    threadId: thread.id,
    botId: bot.id,
    type: "agent.tool.called",
    runId,
    payload: { name: event.name, executionId: event.executionId },
  });
  reply.pendingToolNames.push(event.name);
  tryFlushPendingTools(reply);
  const loopGuard = advanceToolCallLoopGuard(ctx.state.toolCallStreak, event.name, event.args);
  ctx.state.toolCallStreak = loopGuard.streak;
  if (loopGuard.stuck) {
    await stopStuckToolLoop(ctx, event.name);
    return true;
  }
  if (!ctx.scripted) return false;
  const startedAt = Date.now();
  const audit = { spaceId: run.spaceId, threadId: thread.id, botId: bot.id, runId };
  try {
    const result = await applyTool(ctx, event.name, event.args, event.executionId);
    await appendToolCompletionAudit(
      deps,
      audit,
      toolCompletionFromResult(
        {
          name: event.name,
          executionId: event.executionId,
          durationMs: Date.now() - startedAt,
        },
        result,
      ),
      ctx.secrets,
    );
    return isToolPauseResult(result);
  } catch (error) {
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
async function stopStuckToolLoop(ctx: RunContext, toolName: string) {
  const { deps, run, runId, bot, thread, workerId, fence } = ctx;
  const { reply } = ctx.state;
  ctx.tools.approvedReplays.assertDrained();
  flushPendingTools(reply);
  if (!(await renewRunLease(deps, runId, workerId, fence))) return;
  if (reply.messageSegments.length > 0) {
    await publishMessage(deps, run, "bot", redactBlocks(reply.messageSegments, ctx.secrets));
  }
  await ctx.computer.checkpoint.flush();
  ctx.state.terminalCheckpointComplete = true;
  const stuckText = loopGuardStopText(humanizeToolName(toolName), ctx.state.toolCallStreak.count);
  await ctx.settleRunningHelpers();
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
  ctx.stopHeartbeatAfterCompletion();
  if (run.trigger === "routine" && run.routineId) {
    await clearRoutineBackoff(deps, run.routineId);
  }
  if (stopped.continuationRunId) {
    await deps.jobs
      .enqueue(runContinueJob(stopped.continuationRunId))
      .catch((error) => getLogger().error("steering continuation enqueue", error));
  }
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

/** The turn ended: apply a scripted runtime's files and memory, then finalize the reply. */
export async function completeRun(ctx: RunContext) {
  const { deps, run, runId, bot, thread, context } = ctx;
  const { reply } = ctx.state;
  recordExplicitNoResponse(reply, reply.assistantTurnText);
  ctx.computer.lazy.throwIfFailed();
  if (ctx.state.approval.pausePending || !ctx.state.lease.valid) return;
  ctx.tools.approvedReplays.assertDrained();
  reply.pendingProgress += reply.redactor.finish();
  await flushProgress(ctx);

  for (const turn of ctx.script ?? []) {
    for (const file of turn.files ?? []) {
      ctx.computer.checkpoint.markDirty();
      await deps.sandbox.writeFile(
        await ctx.computer.get("script"),
        {
          path: resolveBotWorkspacePath(ctx.computer.mode, bot.id, file.path),
          content: new TextEncoder().encode(file.content),
        },
        context,
      );
    }
    for (const mem of turn.memory ?? []) {
      await deps.memory.commit(
        {
          scope: mem.scope,
          botId: mem.scope === "bot" ? bot.id : undefined,
          path: mem.path,
          content: mem.content,
          sourceRunId: runId,
          sourceThreadId: thread.id,
        },
        context,
      );
      await deps.events.append({
        spaceId: run.spaceId,
        threadId: thread.id,
        botId: bot.id,
        type: "memory.revised",
        runId,
        payload: { path: mem.path, scope: mem.scope },
      });
    }
  }

  await ctx.computer.checkpoint.flush();
  ctx.state.terminalCheckpointComplete = true;

  // Preserve the last held-back preview as a normal final reply when the
  // model supplies none, unless it chose silence or already delivered that text.
  // Persisting peer results here also lets outcome delivery retry after completion.
  recordExplicitNoResponse(reply, reply.lastDiscardedMidTurnNarration);
  if (
    !isBackgroundRunTrigger(run.trigger) &&
    !ctx.state.handedOff &&
    !reply.explicitNoResponse &&
    !reply.assembled.trim() &&
    reply.lastDiscardedMidTurnNarration &&
    !reply.midTurnUserTexts.includes(reply.lastDiscardedMidTurnNarration)
  ) {
    reply.assembled = reply.lastDiscardedMidTurnNarration;
    reply.currentTextSegment = reply.assembled;
  }
  flushPendingTools(reply);
  // Silent-allowed runs can choose an explicit NO_RESPONSE or finish empty.
  // Other runs still drop a stray sentinel at the edges of a real reply.
  const silentReply = ctx.allowSilentEmptyRun
    ? stripNoResponseReply(reply.assembled, reply.messageSegments)
    : stripStrayNoResponse(reply.assembled, reply.messageSegments);
  let completionBlocks = silentReply.blocks;
  if (!silentReply.assembled || isBackgroundRunTrigger(run.trigger)) {
    // Mid-turn progress already posted durable chat messages; skip the empty
    // "…" fallback so we do not add a junk final bubble. Delegated bot_message
    // runs still return via botMessageOutcomeFromMidTurn below (status when
    // only progress was posted, result when a final reply exists). Exact
    // NO_RESPONSE finals are treated as empty before this fallback runs.
    completionBlocks = completionMessageSegments(completionBlocks, {
      allowSilentEmpty: ctx.allowSilentEmptyRun || reply.publishedMidTurnUserMessage,
      emptyResponseText: ctx.emptyResponseText,
      suppressOutput: ctx.state.handedOff || isBackgroundRunTrigger(run.trigger),
      skipEmptyFallback: reply.publishedTerminalSubagent || reply.publishedMidTurnUserMessage,
    });
  }
  const blocks = ctx.state.handedOff
    ? []
    : finalBlocksAfterMidTurnProgress(
        redactBlocks(completionBlocks, ctx.secrets),
        reply.publishedMidTurnUserMessage || runAllowsSilentEmpty(run.trigger),
      );
  const text = ctx.state.handedOff
    ? ""
    : redactSecrets(completionNotificationBody(silentReply.assembled, blocks), ctx.secrets);
  if (containsSecret(text, ctx.secrets)) {
    throw new Error("refusing to persist a secret in the thread");
  }
  // Tool steps succeeded and the only completion text is the synthetic
  // empty notice. That is a missed final answer or a swallowed provider
  // failure, not a successful delegated summary.
  if (
    !ctx.state.handedOff &&
    !silentReply.assembled.trim() &&
    emptyDelegatedToolTurnShouldFail(completionBlocks)
  ) {
    throw new Error(TOOL_STEPS_WITHOUT_RESPONSE);
  }
  if (!(await renewRunLease(deps, runId, ctx.workerId, ctx.fence))) return;
  const botMessageOutcome =
    run.trigger === "bot_message"
      ? botMessageOutcomeFromMidTurn(text, reply.midTurnUserTexts)
      : null;
  await ctx.settleRunningHelpers();
  const completed = await deps.events.finalizeRun({
    spaceId: run.spaceId,
    threadId: thread.id,
    botId: bot.id,
    runId,
    taskId: run.taskId,
    attemptId: ctx.attempt.id,
    leaseOwner: ctx.workerId,
    leaseFence: ctx.fence,
    outcome: "completed",
    blocks,
    markUnread: completionMarksUnread(
      run.trigger,
      text,
      ctx.source.peerMessage?.repliesToRequest === true,
    ),
  });
  if (!completed) return;
  ctx.stopHeartbeatAfterCompletion();
  if (run.trigger === "routine" && run.routineId) {
    await clearRoutineBackoff(deps, run.routineId);
  }
  const { screenRelease } = ctx.state.computerUse;
  if (screenRelease) screenRelease.keepWarm = true;
  if (completed.continuationRunId) {
    await deps.jobs
      .enqueue(runContinueJob(completed.continuationRunId))
      .catch((error) => getLogger().error("steering continuation enqueue", error));
  }
  if (botMessageOutcome) {
    // Prefer the final reply. If the turn only posted mid-turn progress, return that
    // text explicitly as status. Delivery uses a stable auto-outcome key; mark
    // botOutcomeReturnedAt only after a successful (or intentionally skipped) return
    // so a crash or failed delivery stays visible to the reconciler.
    await returnBotMessageOutcome(
      deps,
      { ...run, sourceMessageId: run.sourceMessageId },
      { id: bot.id, name: bot.name },
      botMessageOutcome.text,
      botMessageOutcome.intent,
    ).catch((error) => getLogger().error("bot message result return", error));
  }
  const notifyBody = completionNotificationPreview(text);
  if (runSendsFinishNotification(run.trigger) && notifyBody && !completed.continuationRunId) {
    await notifyRun(deps, run, {
      kind: "completion",
      title: `${displayName(bot.name, "Bot")} finished`,
      body: notifyBody,
      botId: bot.id,
      threadId: thread.id,
    });
  }
  // Last, and never fatal: the run is already finalized, so a failure here must not reach
  // the failure path, where a second finalizeRun would match no rows and silently
  // skip the completion notification.
  try {
    const updatedThread = await deps.prisma.thread.findUniqueOrThrow({
      where: { id: thread.id },
      select: {
        nextMessageSeq: true,
        historyCompactedUpToSeq: true,
      },
    });
    if (
      (deps.contextStrategy ?? DEFAULT_CONTEXT_STRATEGY) === "current" &&
      shouldEnqueueCompaction(
        updatedThread.nextMessageSeq,
        updatedThread.historyCompactedUpToSeq,
        HISTORY_WINDOW_SIZE,
        COMPACTION_BATCH_SIZE,
      )
    ) {
      await deps.jobs.enqueue(historyCompactJob(thread.id));
    }
  } catch (error) {
    getLogger().error("history.compact enqueue failed", error);
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
    if (!(computerError instanceof SandboxRateLimitError)) throw computerError;
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
    error instanceof SandboxRateLimitError
  ) {
    // Provider outages that outlasted retries, provider accounts, plans and model
    // choices the user fixes, unusable model output and the computer provider's own
    // rate limit are not server faults; the run error already tells the user what to do.
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
      },
    );
  }
  if (failed.continuationRunId) {
    await deps.jobs
      .enqueue(runContinueJob(failed.continuationRunId))
      .catch((error) => getLogger().error("steering continuation enqueue", error));
  }
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
  // A refusal of the deployment's own key is the operator's problem, not the user's.
  if (
    run.trigger === "routine" &&
    run.routineId &&
    model.ownCredential &&
    isModelAccountRefusal(error)
  ) {
    await backOffRoutineAfterAccountError(deps, run.routineId);
  }
  const retrying = !failed.continuationRunId && (await scheduleRoutineRetry(deps, run, error));
  if (runSendsFinishNotification(run.trigger) && !failed.continuationRunId && !retrying) {
    await notifyRun(deps, run, {
      kind: "failure",
      title: `${displayName(bot.name, "Bot")} failed`,
      body: message,
      botId: bot.id,
      threadId: thread.id,
    });
  }
}
