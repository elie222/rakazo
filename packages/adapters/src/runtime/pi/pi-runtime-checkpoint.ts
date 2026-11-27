import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Context, Message } from "@earendil-works/pi-ai";
import type { AgentContextStrategy, AgentRunModel } from "@rakazo/adapter-kit";
import { isRecord } from "@rakazo/core";
import { MAX_OUTSIDE_TEXT_CHARS } from "../../approvals/review-target-sources.js";
import { watchChecksFromToolResultMessage } from "../../runs/assembly/watch-outside-text.js";
import type { ComputerModeCheckpoint, TurnCheckpoint } from "../../runs/turn/turn-checkpoint.js";
import {
  serializeTurnCheckpoint,
  unresolvedTurnCheckpointCalls,
} from "../../runs/turn/turn-checkpoint.js";
import type { WatchDeliveryState } from "../context/runtime-context.js";
import { computerSelection } from "./tools/pi-runtime-computer-mode.js";

/**
 * Delivered text with no watch checks. A later slice of the same watch is passed as an extra
 * delivery beside it, so extraction uses that slice alone and does not fall through to the
 * full routines.
 */
const EMPTY_WATCH_DELIVERY = '{"routines":[]}';

interface WatchOutsidePiece {
  text: string;
  /** Checkpoint message index before which this dropped slice is replayed. */
  before: number;
}

/** Tail of `value` that fits in `maxChars` and does not start on a lone low surrogate. */
function sliceWellFormedTail(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  let start = value.length - maxChars;
  const code = value.charCodeAt(start);
  const previous = value.charCodeAt(start - 1);
  if (code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) start += 1;
  return value.slice(start);
}

/** Keeps the newest tail of checkpoint watch text, including the `\n` between entries. */
function boundWatchOutsideText(entries: readonly WatchOutsidePiece[]): WatchOutsidePiece[] {
  const kept: WatchOutsidePiece[] = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const separator = kept.length > 0 ? 1 : 0;
    const room = MAX_OUTSIDE_TEXT_CHARS - used - separator;
    if (room <= 0) break;
    if (entry.text.length <= room) {
      kept.push(entry);
      used += separator + entry.text.length;
      continue;
    }
    const text = sliceWellFormedTail(entry.text, room);
    if (!text) break;
    kept.push({ text, before: entry.before });
    break;
  }
  kept.reverse();
  return kept;
}

function acceptedTextOrder(entry: WatchDeliveryState, index: number, insertion: number): number {
  const explicit = entry.full ? entry.order : entry.textOrders?.[index];
  if (explicit !== undefined) return explicit;
  return insertion * 1_000_000 + index;
}

export const ANSWERED_ON_RESUME = new Set(["ask_user", "request_takeover"]);

export interface TurnStopState {
  pausePending: boolean;
  terminatedReply: string | undefined;
  toolCallBudgetExceeded: boolean;
}

/**
 * Whether a pause, terminating tool reply, or tool-call budget stop already ended this turn,
 * even when Pi 1.6+ also emits synthetic aborted results for trailing calls in the batch.
 */
export function isTurnEndingAfterToolBatch(state: TurnStopState): boolean {
  return state.pausePending || Boolean(state.terminatedReply) || state.toolCallBudgetExceeded;
}

/**
 * Whether a completed tool event represents an executed result to retain for a parallel
 * checkpoint. Pi 1.6+ omits `durationMs` on synthetic "Operation aborted" results for calls
 * that never executed; executed parallel failures still carry `durationMs` and stay kept.
 */
export function shouldRecordFinishedToolCall(
  event: { result: { terminate?: unknown }; isError: boolean; durationMs?: number },
  turnSignal?: AbortSignal,
): boolean {
  return (
    !event.result.terminate &&
    !(event.isError && event.durationMs === undefined && turnSignal?.aborted)
  );
}

export function buildTurnCheckpoint(input: {
  sentContext?: {
    context: Context;
    sourceLength: number;
    sourceIndexes?: ReadonlyArray<number | undefined>;
  };
  stateMessages: readonly AgentMessage[];
  restoringCalls: boolean;
  tools: readonly AgentTool[];
  pendingToolCallId: string;
  toolCallCount: number;
  computerMode?: ComputerModeCheckpoint;
  mainModelConfig: AgentRunModel;
  provider: string;
  modelId: string;
  systemPrompt: string;
  representedHistoryIds: ReadonlySet<string>;
  foundConnectorTools?: ReadonlyMap<string, string>;
  watchDeliveries?: ReadonlyMap<string, WatchDeliveryState>;
  priorWatchOutsideText?: readonly string[];
  restoredMessages?: readonly Message[];
  contextStrategy?: AgentContextStrategy;
}): TurnCheckpoint {
  const messages = input.sentContext
    ? [
        ...input.sentContext.context.messages,
        ...input.stateMessages.slice(input.sentContext.sourceLength),
      ]
    : [...input.stateMessages];
  const messageSourceIndexes: ReadonlyArray<number | undefined> | undefined = input.sentContext
    ? input.sentContext.sourceIndexes
      ? [
          ...input.sentContext.sourceIndexes,
          ...input.stateMessages
            .slice(input.sentContext.sourceLength)
            .map((_, offset) => input.sentContext!.sourceLength + offset),
        ]
      : undefined
    : input.stateMessages.map((_, index) => index);
  const retainedWatch: Array<Extract<AgentMessage, { role: "toolResult" }>> = [];
  const retainedWatchBySourceIndex = new Map<
    number,
    Extract<AgentMessage, { role: "toolResult" }>
  >();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (
      message.role !== "toolResult" ||
      !isRecord(message.details) ||
      !("routines" in message.details)
    )
      continue;
    retainedWatch.push(message);
    const sourceIndex = messageSourceIndexes?.[index];
    if (sourceIndex !== undefined) retainedWatchBySourceIndex.set(sourceIndex, message);
  }
  const retainedMessageIndex = (entry: WatchDeliveryState): number | undefined => {
    const match =
      messageSourceIndexes !== undefined && entry.sourceIndex !== undefined
        ? retainedWatchBySourceIndex.get(entry.sourceIndex)
        : retainedWatch.find(
            (message) =>
              message.toolCallId === entry.toolCallId &&
              isRecord(message.details) &&
              message.details.routines === entry.details.routines,
          );
    if (!match) return undefined;
    const index = messages.indexOf(match);
    return index === -1 ? undefined : index;
  };
  const droppedWatchOutside: WatchOutsidePiece[] = (input.priorWatchOutsideText ?? [])
    .filter((entry) => entry.trim().length > 0)
    .map((text) => ({ text, before: 0 }));
  // Collect in chronological delivery order (prior dropped -> earlier restored -> current attempt)
  // so bounded outsideText retention (`MAX_OUTSIDE_TEXT_CHARS`) keeps the newest watch evidence.
  if (input.restoredMessages) {
    // Only results before the paused assistant turn in the restored checkpoint were actually
    // delivered to an earlier model; trailing sibling results await their first delivery.
    // Pi prepends a leading system message when initializing a legacy checkpoint without one.
    const restoredOffset =
      input.restoredMessages.length > 0 &&
      input.stateMessages[0]?.role === "system" &&
      input.restoredMessages[0]?.role !== "system"
        ? 1
        : 0;
    const lastRestoredAssistant = input.restoredMessages.findLastIndex(
      (message) => message.role === "assistant",
    );
    for (let index = 0; index < lastRestoredAssistant; index += 1) {
      const message = input.restoredMessages[index]!;
      if (message.role !== "toolResult") continue;
      const details = message.details;
      if (!isRecord(details) || !("routines" in details)) continue;
      const restoredItems = watchChecksFromToolResultMessage(message, input.contextStrategy)
        .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
        .filter((value) => value.trim().length > 0);
      if (restoredItems.length === 0) continue;
      const retainedMatch =
        messageSourceIndexes !== undefined
          ? retainedWatchBySourceIndex.get(index + restoredOffset)
          : retainedWatch.find(
              (retained) =>
                retained.toolCallId === message.toolCallId &&
                isRecord(retained.details) &&
                retained.details.routines === details.routines,
            );
      if (!retainedMatch) {
        for (const text of restoredItems) droppedWatchOutside.push({ text, before: 0 });
        continue;
      }
      const retainedSet = new Set(
        watchChecksFromToolResultMessage(retainedMatch, input.contextStrategy).map((item) =>
          typeof item === "string" ? item : JSON.stringify(item),
        ),
      );
      for (const value of restoredItems) {
        if (!retainedSet.has(value)) droppedWatchOutside.push({ text: value, before: 0 });
      }
    }
  }
  if (input.watchDeliveries) {
    const slices: Array<{
      order: number;
      entry: WatchDeliveryState;
      text: string;
      index: number;
      retainedAt?: number;
    }> = [];
    let insertion = 0;
    for (const entry of input.watchDeliveries.values()) {
      insertion += 1;
      const retainedAt = retainedMessageIndex(entry);
      if (entry.full) {
        slices.push({
          order: acceptedTextOrder(entry, 0, insertion),
          entry,
          text: entry.fullText,
          index: 0,
          ...(retainedAt !== undefined ? { retainedAt } : {}),
        });
        continue;
      }
      entry.texts.forEach((text, index) => {
        slices.push({
          order: acceptedTextOrder(entry, index, insertion),
          entry,
          text,
          index,
          ...(retainedAt !== undefined ? { retainedAt } : {}),
        });
      });
    }
    const retainedAnchors = new Map<number, number>();
    for (const slice of slices) {
      if (slice.retainedAt === undefined) continue;
      const current = retainedAnchors.get(slice.retainedAt);
      if (current === undefined || slice.order > current) {
        retainedAnchors.set(slice.retainedAt, slice.order);
      }
    }
    const anchors = [...retainedAnchors.entries()]
      .map(([messageIndex, order]) => ({ messageIndex, order }))
      .sort((left, right) => left.order - right.order || left.messageIndex - right.messageIndex);
    slices.sort((left, right) => left.order - right.order || left.index - right.index);
    for (const slice of slices) {
      if (slice.retainedAt !== undefined || !slice.text.trim()) continue;
      const nextAnchor = anchors.find((anchor) => anchor.order > slice.order);
      const before = nextAnchor
        ? nextAnchor.messageIndex
        : anchors.length > 0
          ? messages.length
          : 0;
      const firstSlice = slice.entry.full || slice.index === 0;
      const synthetic = firstSlice
        ? {
            details: { ...slice.entry.details, contextBeforeUseText: slice.text },
            content: [{ type: "text" as const, text: slice.text }],
          }
        : {
            details: {
              ...slice.entry.details,
              contextBeforeUseText: EMPTY_WATCH_DELIVERY,
              contextDeliveredTexts: [slice.text],
            },
            content: [{ type: "text" as const, text: EMPTY_WATCH_DELIVERY }],
          };
      for (const item of watchChecksFromToolResultMessage(synthetic, input.contextStrategy)) {
        const value = typeof item === "string" ? item : JSON.stringify(item);
        if (value.trim()) droppedWatchOutside.push({ text: value, before });
      }
    }
  }
  const seenWatchOutside = new Map<string, number>();
  for (const entry of droppedWatchOutside) {
    seenWatchOutside.delete(entry.text);
    seenWatchOutside.set(entry.text, entry.before);
  }
  const boundedWatchOutside = boundWatchOutsideText(
    [...seenWatchOutside.entries()].map(([text, before]) => ({ text, before })),
  );
  const watchOutsideText = boundedWatchOutside.map((entry) => entry.text);
  const watchOutsideTextBefore = boundedWatchOutside.map((entry) => entry.before);
  const assistant = messages.findLast((message) => message.role === "assistant");
  const sequential =
    input.restoringCalls ||
    (assistant?.role === "assistant" &&
      assistant.content.some(
        (call) =>
          call.type === "toolCall" &&
          input.tools.find((tool) => tool.name === call.name)?.executionMode === "sequential",
      ));
  // A turn paused on a question or takeover gets its answer on resume without running
  // the call again, so the count it resumes with already includes that call.
  const answeredOnResume =
    assistant?.role === "assistant" &&
    assistant.content.some(
      (call) =>
        call.type === "toolCall" &&
        call.id === input.pendingToolCallId &&
        ANSWERED_ON_RESUME.has(call.name),
    );
  const toolCallCount = input.toolCallCount + (answeredOnResume ? 1 : 0);
  return {
    version: 1 as const,
    ...(input.computerMode
      ? {
          computerMode: {
            ...input.computerMode,
            main: computerSelection(input.mainModelConfig),
          },
        }
      : {}),
    provider: input.provider,
    model: input.modelId,
    systemPrompt: input.systemPrompt,
    pendingToolCallId: input.pendingToolCallId,
    ...(toolCallCount > 0 && { toolCallCount }),
    executionMode: sequential ? ("sequential" as const) : ("parallel" as const),
    messages: messages as Message[],
    historyMessageIds: [...input.representedHistoryIds],
    ...(input.foundConnectorTools?.size
      ? { foundConnectorTools: [...input.foundConnectorTools] }
      : {}),
    ...(watchOutsideText.length > 0 ? { watchOutsideText, watchOutsideTextBefore } : {}),
  };
}

export function serializeCapturedTurnCheckpoint(
  checkpoint: TurnCheckpoint,
  pendingToolCallId: string,
  finishedCalls: ReadonlyMap<string, Message>,
): string {
  // Sequential batches publish each prior toolResult into state before the next
  // call starts; any other unresolved call in a sequential batch is an unstarted tail.
  if (checkpoint.executionMode === "sequential") {
    return serializeTurnCheckpoint(checkpoint);
  }
  const unresolved = new Set(unresolvedTurnCheckpointCalls(checkpoint.messages));
  const siblings = checkpoint.messages.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((call) => {
          if (call.type !== "toolCall" || call.id === pendingToolCallId || !unresolved.has(call))
            return [];
          const result = finishedCalls.get(call.id);
          return result ? [result] : [];
        })
      : [],
  );
  return serializeTurnCheckpoint({
    ...checkpoint,
    messages: [...checkpoint.messages, ...siblings],
  });
}
