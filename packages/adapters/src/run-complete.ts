import {
  DEFAULT_CONTEXT_STRATEGY,
  historyCompactJob,
  memoryRetainTurnJob,
} from "@rakazo/adapter-kit";
import {
  BACKGROUND_HELPER_TRIGGER,
  containsSecret,
  displayName,
  isBackgroundRunTrigger,
  redactSecrets,
  withoutLastToolStepNotes,
} from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { returnHelperOutcome } from "./background-helpers.js";
import { returnBotMessageOutcome } from "./bot-messages.js";
import { resolveBotWorkspacePath } from "./computer-support.js";
import { answeredSteeringMessageIds, retainsConversationTurn } from "./conversation-memory.js";
import {
  COMPACTION_BATCH_SIZE,
  HISTORY_WINDOW_SIZE,
  shouldEnqueueCompaction,
} from "./history-compaction.js";
import { clearRoutineBackoff } from "./routine-backoff.js";
import type { RunContext } from "./run-context.js";
import { enqueueSteeringContinuation, renewRunLease } from "./run-lifecycle.js";
import { redactBlocks } from "./run-messages.js";
import {
  completionMarksUnread,
  completionNotificationBody,
  completionNotificationPreview,
  notifyRun,
  runSendsFinishNotification,
} from "./run-notifications.js";
import {
  flushPendingTools,
  flushProgress,
  recordExplicitNoResponse,
  withReplyToolOutcomes,
} from "./run-progress.js";
import {
  completionMessageSegments,
  emptyDelegatedToolTurnShouldFail,
  runAllowsSilentEmpty,
  TOOL_STEPS_WITHOUT_RESPONSE,
} from "./run-replies.prompt.js";
import {
  isNoResponseReply,
  isPlaceholderReply,
  peerReplyWithoutSentinel,
  stripNoResponseReply,
  stripStrayNoResponse,
} from "./silent-reply.js";
import { isStrategicInitiativeRun } from "./strategic-initiative.js";
import { saveLatestStepScreenshot } from "./tool-step-calls.js";
import {
  assistantTurnSeparator,
  botMessageOutcomeFromMidTurn,
  finalBlocksAfterMidTurnProgress,
} from "./user-progress.js";

/**
 * Silence needs the send to still call the reply optional (a person who names the member while
 * it works makes it required) and nothing of this run already in the chat, such as an ask card.
 */
async function groupSilenceStillAllowed(ctx: RunContext) {
  const { prisma } = ctx.deps;
  const current = await prisma.run.findUnique({
    where: { id: ctx.runId },
    select: { groupReplyOptional: true },
  });
  if (current?.groupReplyOptional !== true) return false;
  const earlier = await prisma.message.findFirst({
    where: { runId: ctx.runId, role: "bot" },
    select: { id: true },
  });
  return !earlier;
}

/** Finalization deletes steering claims, so collect them before either completion path. */
export async function conversationRetentionMessages(
  ctx: RunContext,
): Promise<string[] | undefined> {
  const { run, thread } = ctx;
  if (
    !retainsConversationTurn({
      trigger: run.trigger,
      sourceMessageId: run.sourceMessageId,
      runBotId: run.botId,
      threadBotId: thread.botId,
      threadGroupId: thread.groupId,
      nonOwnerChatRun: ctx.source.messagingChannelRun,
      provider: ctx.memory.semantic,
    })
  )
    return undefined;
  return answeredSteeringMessageIds(ctx.deps, ctx.runId);
}

export async function enqueueConversationRetention(
  ctx: RunContext,
  messageIds: string[] | undefined,
) {
  if (!messageIds) return;
  await ctx.deps.jobs
    .enqueue(memoryRetainTurnJob(ctx.runId, messageIds))
    .catch((error) => getLogger().error("memory.retain-turn enqueue failed", error));
}

/** The turn ended: apply a scripted runtime's files and memory, then finalize the reply. */
export async function completeRun(ctx: RunContext) {
  const { deps, run, runId, bot, thread } = ctx;
  const { reply } = ctx.state;
  recordExplicitNoResponse(reply, reply.assistantTurnText);
  ctx.computer.lazy.throwIfFailed();
  if (ctx.state.approval.pausePending || !ctx.state.lease.valid) return;
  ctx.tools.approvedReplays.assertDrained();
  reply.pendingProgress += reply.redactor.finish();
  await flushProgress(ctx);

  await applyScriptedTurns(ctx);

  await ctx.computer.checkpoint.flush();
  ctx.state.terminalCheckpointComplete = true;

  const { blocks, text, groupSilentEnd } = await finalReply(ctx);
  if (!(await renewRunLease(deps, runId, ctx.workerId, ctx.fence))) return;
  const botMessageOutcome =
    run.trigger === "bot_message"
      ? botMessageOutcomeFromMidTurn(text, reply.midTurnUserTexts)
      : null;
  const marksUnread =
    (!ctx.allowSilentEmptyRun || blocks.length > 0 || reply.publishedMidTurnUserMessage) &&
    completionMarksUnread(run.trigger, text, ctx.source.peerMessage?.repliesToRequest === true);
  await ctx.settleRunningHelpers();
  const answeredMessageIds = await conversationRetentionMessages(ctx);
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
    markUnread: !groupSilentEnd && marksUnread,
  });
  if (!completed) return;
  ctx.stopHeartbeatAfterCompletion();
  if (run.trigger === "routine" && run.routineId) {
    await clearRoutineBackoff(deps, { routineId: run.routineId, userId: run.userId });
  }
  const { screenRelease } = ctx.state.computerUse;
  if (screenRelease) screenRelease.keepWarm = true;
  await enqueueSteeringContinuation(deps, completed.continuationRunId);
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
  if (run.trigger === BACKGROUND_HELPER_TRIGGER) {
    await returnHelperOutcome(deps, run, { status: "completed", text }).catch((error) =>
      getLogger().error("background helper result return", error),
    );
  }
  const notifyBody = completionNotificationPreview(text);
  // Agent-to-agent work the chat stays read for is not news to the user either.
  if (
    runSendsFinishNotification(run.trigger) &&
    marksUnread &&
    notifyBody &&
    !completed.continuationRunId
  ) {
    await notifyRun(deps, run, {
      kind: "completion",
      title: `${displayName(bot.name, "Bot")} finished`,
      body: notifyBody,
      botId: bot.id,
      threadId: thread.id,
      runId: run.id,
    });
  }
  await enqueueConversationRetention(ctx, answeredMessageIds);
  await enqueueHistoryCompaction(ctx);
}

/** A scripted runtime's turns carry the files and memory it writes. */
async function applyScriptedTurns(ctx: RunContext) {
  const { deps, run, runId, bot, thread, context } = ctx;
  for (const turn of isStrategicInitiativeRun(run) ? [] : (ctx.script ?? [])) {
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
}

/** The reply the run finalizes with, after silence, fallbacks and redaction. */
async function finalReply(ctx: RunContext) {
  const { run } = ctx;
  const { reply } = ctx.state;
  // Preserve the last held-back preview as a normal final reply when the
  // model supplies none, unless it chose silence or already delivered that text.
  // Persisting peer results here also lets outcome delivery retry after completion.
  recordExplicitNoResponse(reply, reply.lastDiscardedMidTurnNarration);
  // When nothing follows the last step, the notes since the last interim message are the reply.
  // Messages mode keeps only the latest one; the earlier ones were private working.
  const fallbackNotes =
    ctx.replyMode === "messages" ? reply.workingNotes.slice(-1) : reply.workingNotes;
  if (
    !isBackgroundRunTrigger(run.trigger) &&
    !ctx.state.handedOff &&
    !reply.explicitNoResponse &&
    reply.workingNotes.length > 0 &&
    !reply.textSinceLastStep.trim()
  ) {
    flushPendingTools(reply);
    reply.messageSegments = withoutLastToolStepNotes(reply.messageSegments, fallbackNotes.length);
    const notes = fallbackNotes.join("\n\n");
    const separator = assistantTurnSeparator(reply.assembled, notes);
    reply.assembled += separator + notes;
    reply.currentTextSegment += separator + notes;
  }
  // Runs that hold their narration back keep only the last held-back preview.
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
  await saveLatestStepScreenshot(ctx);
  reply.messageSegments = withReplyToolOutcomes(reply);
  // Silent-allowed runs can choose an explicit NO_RESPONSE or finish empty.
  // Other runs still drop a stray sentinel at the edges of a real reply.
  // A member a group message named nobody for may end silently with the sentinel, a placeholder
  // such as a lone dot, or nothing at all, as long as it did no work: tool steps or a posted
  // message are still shown.
  const groupSilentEnd =
    ctx.groupReplyOptional &&
    !ctx.allowSilentEmptyRun &&
    (isNoResponseReply(reply.assembled, reply.messageSegments) ||
      isPlaceholderReply(reply.assembled, reply.messageSegments) ||
      !(reply.assembled.trim() || reply.messageSegments.length)) &&
    !reply.publishedMidTurnUserMessage &&
    !reply.publishedTerminalSubagent &&
    reply.messageSegments.every((block) => block.kind === "text") &&
    (await groupSilenceStillAllowed(ctx));
  const silentReply = groupSilentEnd
    ? { assembled: "", blocks: [] }
    : ctx.allowSilentEmptyRun || ctx.groupReplyOptional
      ? stripNoResponseReply(reply.assembled, reply.messageSegments)
      : (ctx.source.peerMessage?.intent === "request" ||
            ctx.source.peerMessage?.intent === "question") &&
          !reply.publishedMidTurnUserMessage
        ? peerReplyWithoutSentinel(reply.assembled, reply.messageSegments)
        : stripStrayNoResponse(reply.assembled, reply.messageSegments);
  let completionBlocks = silentReply.blocks;
  if (!silentReply.assembled || isBackgroundRunTrigger(run.trigger)) {
    // Mid-turn progress already posted durable chat messages; skip the empty
    // "…" fallback so we do not add a junk final bubble.
    completionBlocks = completionMessageSegments(completionBlocks, {
      allowSilentEmpty:
        ctx.allowSilentEmptyRun || reply.publishedMidTurnUserMessage || groupSilentEnd,
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
  return { blocks, text, groupSilentEnd };
}

// Last, and never fatal: the run is already finalized, so a failure here must not reach
// the failure path, where a second finalizeRun would match no rows and silently
// skip the completion notification.
async function enqueueHistoryCompaction(ctx: RunContext) {
  const { deps, run, thread } = ctx;
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
      await deps.jobs.enqueue(historyCompactJob(thread.id, run.userId));
    }
  } catch (error) {
    getLogger().error("history.compact enqueue failed", error);
  }
}
