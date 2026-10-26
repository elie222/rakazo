import type { MessageBlock } from "@rakazo/contracts";
import {
  appendTextSegment,
  appendToolCallSegment,
  createStreamingRedactor,
  endsSentence,
  isBackgroundRunTrigger,
  redactSecrets,
} from "@rakazo/core";
import type { Run } from "@rakazo/db";
import type { ExecutorDeps } from "./executor-deps.js";
import type { ReplyState, RunContext } from "./run-context.js";
import { publishMessage } from "./run-messages.js";
import { runPromotesMidTurnNarration } from "./run-replies.js";
import { isExactNoResponse } from "./silent-reply.js";
import {
  clampUserProgressMessage,
  extractNarrationText,
  isUserProgressClientNonce,
  midTurnProgressBudgetAllows,
  userProgressClientNonce,
} from "./user-progress.js";

/** A fresh reply that knows the progress messages earlier attempts of this run posted. */
export async function createReplyState(
  deps: ExecutorDeps,
  run: Run,
  secrets: string[],
): Promise<ReplyState> {
  const reply: ReplyState = {
    assembled: "",
    currentTextSegment: "",
    messageSegments: [],
    publishedTerminalSubagent: false,
    publishedMidTurnUserMessage: false,
    discardedMidTurnNarration: false,
    lastDiscardedMidTurnNarration: "",
    explicitNoResponse: false,
    assistantTurnText: "",
    midTurnUserTexts: [],
    midTurnProgressCount: 0,
    turnStartedAtMs: run.startedAt?.getTime() ?? Date.now(),
    pendingToolNames: [],
    pendingProgress: "",
    lastProgressAt: 0,
    hasStreamedText: false,
    assistantTurnBreakPending: false,
    redactor: createStreamingRedactor(secrets),
  };
  const priorProgress = await deps.prisma.message.findMany({
    where: { runId: run.id, role: "bot" },
    orderBy: { seq: "asc" },
    select: { blocks: true, clientNonce: true },
  });
  for (const message of priorProgress) {
    if (!isUserProgressClientNonce(message.clientNonce)) continue;
    const blocks = Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : [];
    const text = blocks
      .filter((block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!text) continue;
    reply.midTurnUserTexts.push(text);
    reply.publishedMidTurnUserMessage = true;
    reply.midTurnProgressCount += 1;
  }
  return reply;
}

export function recordExplicitNoResponse(reply: ReplyState, text: string) {
  reply.explicitNoResponse ||= isExactNoResponse(text) || /\bNO_RESPONSE\b/.test(text);
}

/** Durable interim messages only on genuinely long turns, capped per run. */
export function canPublishDurableProgress(reply: ReplyState) {
  return midTurnProgressBudgetAllows(
    reply.midTurnProgressCount,
    Date.now() - reply.turnStartedAtMs,
  );
}

export function canPublishDurableNarration(ctx: RunContext) {
  return runPromotesMidTurnNarration(ctx.run.trigger) && canPublishDurableProgress(ctx.state.reply);
}

export function flushPendingTools(reply: ReplyState) {
  if (reply.currentTextSegment) {
    reply.messageSegments = appendTextSegment(reply.messageSegments, reply.currentTextSegment);
    reply.currentTextSegment = "";
  }
  for (const name of reply.pendingToolNames) {
    reply.messageSegments = appendToolCallSegment(reply.messageSegments, name);
  }
  reply.pendingToolNames = [];
}

export function tryFlushPendingTools(reply: ReplyState) {
  if (reply.pendingToolNames.length > 0 && endsSentence(reply.currentTextSegment))
    flushPendingTools(reply);
}

export async function flushProgress(ctx: RunContext) {
  const { deps, run, runId, bot, thread } = ctx;
  const { reply } = ctx.state;
  // Routines may finish silently. Do not leak narration or a partial silence
  // sentinel before the final outcome is known.
  if (
    ctx.scripted ||
    !reply.pendingProgress ||
    run.trigger === "routine" ||
    isBackgroundRunTrigger(run.trigger)
  )
    return;
  await deps.events.append({
    spaceId: run.spaceId,
    threadId: thread.id,
    botId: bot.id,
    type: "thread.progress",
    runId,
    // The first flush replaces the "working…" placeholder outright — a delta here
    // would otherwise get appended straight onto it with no separator.
    payload: reply.hasStreamedText
      ? { delta: reply.pendingProgress, streaming: true }
      : { text: reply.pendingProgress, streaming: true },
  });
  reply.hasStreamedText = true;
  reply.pendingProgress = "";
  reply.lastProgressAt = Date.now();
}

export async function publishMidTurnNarration(ctx: RunContext, beforeConnectCard = false) {
  const { deps, run } = ctx;
  const { reply } = ctx.state;
  const extracted = extractNarrationText(reply.messageSegments, reply.currentTextSegment);
  const narration = clampUserProgressMessage(redactSecrets(extracted.text, ctx.secrets));
  const canPublish =
    canPublishDurableNarration(ctx) ||
    (beforeConnectCard && runPromotesMidTurnNarration(run.trigger));
  if (
    narration &&
    !canPublish &&
    !ctx.allowSilentEmptyRun &&
    runPromotesMidTurnNarration(run.trigger)
  ) {
    return;
  }
  reply.messageSegments = extracted.remaining;
  reply.currentTextSegment = "";
  if (!narration) return;
  reply.hasStreamedText = false;
  reply.pendingProgress = "";
  if (!canPublish) {
    reply.assembled = "";
    reply.discardedMidTurnNarration = true;
    reply.lastDiscardedMidTurnNarration = narration;
    return;
  }
  reply.assembled = "";
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
}
