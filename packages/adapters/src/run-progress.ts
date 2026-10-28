import type { MessageBlock } from "@rakazo/contracts";
import {
  appendTextSegment,
  appendToolCallSegment,
  createStreamingRedactor,
  endsSentence,
  isBackgroundRunTrigger,
  noteLastToolStep,
  redactSecretsAfter,
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
  narrationStatusLine,
  USER_PROGRESS_MESSAGE_MAX_LENGTH,
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
    progressBudgetStart: 0,
    steeringReplyPending: false,
    steeringResets: 0,
    lastSteeringResetAt: Number.NEGATIVE_INFINITY,
    workingNotes: [],
    textSinceLastStep: "",
    narrationSoFar: "",
    narrationStatusShowing: false,
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
  return (
    reply.steeringReplyPending ||
    midTurnProgressBudgetAllows(
      reply.midTurnProgressCount - reply.progressBudgetStart,
      Date.now() - reply.turnStartedAtMs,
    )
  );
}

/** The next interim message's nonce; it uses up the allowance for answering the person. */
export function nextProgressNonce(ctx: RunContext) {
  const { reply } = ctx.state;
  reply.steeringReplyPending = false;
  return userProgressClientNonce(ctx.run.id, reply.midTurnProgressCount++);
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

/**
 * Text the bot wrote before a step. It is posted as an interim message when the budget allows
 * and it fits; otherwise it is a note on that step, kept out of the reply. Returns the note so
 * the caller can show it as the working line.
 */
export async function publishMidTurnNarration(ctx: RunContext, beforeConnectCard = false) {
  const { deps, run } = ctx;
  const { reply } = ctx.state;
  const extracted = extractNarrationText(reply.messageSegments, reply.currentTextSegment);
  reply.messageSegments = extracted.remaining;
  reply.currentTextSegment = "";
  const text = redactSecretsAfter(reply.narrationSoFar, extracted.text, ctx.secrets).trim();
  reply.narrationSoFar += extracted.text;
  if (!text) return undefined;
  reply.assembled = "";
  reply.hasStreamedText = false;
  reply.pendingProgress = "";
  // Text the redactor still holds back belongs to the text just taken out.
  reply.redactor.skip();
  const promotes = runPromotesMidTurnNarration(run.trigger);
  if (
    text.length <= USER_PROGRESS_MESSAGE_MAX_LENGTH &&
    (canPublishDurableNarration(ctx) || (beforeConnectCard && promotes))
  ) {
    reply.workingNotes.length = 0;
    reply.narrationStatusShowing = false;
    await publishMessage(
      deps,
      run,
      "bot",
      [{ kind: "text", text }],
      undefined,
      nextProgressNonce(ctx),
    );
    reply.midTurnUserTexts.push(text);
    reply.publishedMidTurnUserMessage = true;
    return undefined;
  }
  reply.discardedMidTurnNarration = true;
  reply.lastDiscardedMidTurnNarration = clampUserProgressMessage(text);
  if (promotes && !ctx.allowSilentEmptyRun) {
    reply.workingNotes.push(text);
    flushPendingTools(reply);
    reply.messageSegments = noteLastToolStep(reply.messageSegments, text);
  }
  return text;
}

/**
 * Replaces the text streamed so far with the note as the working line. Runs that hold their
 * narration back (routines, peers, background work) keep their live view.
 */
export async function showNarrationStatus(ctx: RunContext, note: string | undefined) {
  const { deps, run, runId, bot, thread } = ctx;
  if (
    !note ||
    ctx.scripted ||
    !runPromotesMidTurnNarration(run.trigger) ||
    isBackgroundRunTrigger(run.trigger)
  )
    return;
  ctx.state.reply.narrationStatusShowing = true;
  await deps.events.append({
    spaceId: run.spaceId,
    threadId: thread.id,
    botId: bot.id,
    type: "thread.progress",
    runId,
    payload: { reset: true, text: narrationStatusLine(note), activity: true },
  });
}
