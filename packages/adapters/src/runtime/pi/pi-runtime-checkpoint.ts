import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Context, Message } from "@earendil-works/pi-ai";
import type { AgentContextStrategy, AgentRunModel } from "@rakazo/adapter-kit";
import { isRecord, toolResultTaintsRun } from "@rakazo/core";
import {
  appendOutsideText,
  MAX_OUTSIDE_TEXT_CHARS,
  outsideTextOf,
} from "../../approvals/review-target-sources.js";
import { watchChecksFromToolResultMessage } from "../../runs/assembly/watch-outside-text.js";
import type { ComputerModeCheckpoint, TurnCheckpoint } from "../../runs/turn/turn-checkpoint.js";
import {
  checkpointOmitsToolResult,
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
function boundWatchOutsideText(entries: readonly string[]): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const separator = kept.length > 0 ? 1 : 0;
    const room = MAX_OUTSIDE_TEXT_CHARS - used - separator;
    if (room <= 0) break;
    if (entry.length <= room) {
      kept.push(entry);
      used += separator + entry.length;
      continue;
    }
    const text = sliceWellFormedTail(entry, room);
    if (!text) break;
    kept.push(text);
    break;
  }
  kept.reverse();
  return kept;
}

/** Latest copy of a repeated watch check stays in its newest position. */
function dedupeLatestWatchText(entries: readonly string[]): string[] {
  const seen = new Map<string, true>();
  for (const entry of entries) {
    seen.delete(entry);
    seen.set(entry, true);
  }
  return [...seen.keys()];
}

function watchTextValues(
  message: { details?: unknown; content: unknown },
  contextStrategy?: AgentContextStrategy,
): string[] {
  return watchChecksFromToolResultMessage(message, contextStrategy)
    .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
    .filter((value) => value.trim().length > 0);
}

function noteWrappedToolCalls(message: AgentMessage, wrapped: Map<string, string>) {
  if (message.role !== "assistant") return;
  for (const part of message.content) {
    if (part.type !== "toolCall") continue;
    if (
      part.name === "use_tool" &&
      isRecord(part.arguments) &&
      typeof part.arguments.name === "string"
    ) {
      wrapped.set(part.id, part.arguments.name);
    } else {
      wrapped.delete(part.id);
    }
  }
}

function resolvedToolName(
  message: { role: string; toolName?: string; toolCallId?: string },
  wrapped: ReadonlyMap<string, string>,
): string | undefined {
  if (message.role !== "toolResult" || typeof message.toolName !== "string") return undefined;
  return message.toolName === "use_tool" ? wrapped.get(message.toolCallId ?? "") : message.toolName;
}

function isRoutineWatchName(name: string | undefined): name is "schedule_list" | "task_catalog" {
  return name === "schedule_list" || name === "task_catalog";
}

/** Watch checks only. A clipped page is outside text, not a routine watch. */
function routineWatchTexts(
  message: Message,
  wrapped: ReadonlyMap<string, string>,
  contextStrategy?: AgentContextStrategy,
): string[] {
  if (!isRoutineWatchName(resolvedToolName(message, wrapped))) return [];
  return watchTextValues(message, contextStrategy);
}

function wrappedToolNames(messages: readonly Message[]): Map<string, string> {
  const wrapped = new Map<string, string>();
  for (const message of messages) noteWrappedToolCalls(message, wrapped);
  return wrapped;
}

function scanOutsideSources(
  messages: readonly AgentMessage[],
  contextStrategy?: AgentContextStrategy,
): {
  routineTexts: Map<number, Map<string, number>>;
  pages: Array<{ index: number; text: string }>;
} {
  const wrapped = new Map<string, string>();
  const routineTexts = new Map<number, Map<string, number>>();
  const pages: Array<{ index: number; text: string }> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    noteWrappedToolCalls(message, wrapped);
    if (message.role !== "toolResult") continue;
    const name = resolvedToolName(message, wrapped);
    if (isRoutineWatchName(name)) {
      const counts = new Map<string, number>();
      for (const text of watchTextValues(message, contextStrategy)) {
        counts.set(text, (counts.get(text) ?? 0) + 1);
      }
      if (counts.size > 0) routineTexts.set(index, counts);
      continue;
    }
    // Match the serializer: it strips this result by toolName, not by an unwrapped use_tool name.
    if (checkpointOmitsToolResult(message.toolName)) continue;
    if (!name || !toolResultTaintsRun(name)) continue;
    const text = outsideTextOf(message.content);
    if (text.trim()) pages.push({ index, text });
  }
  return { routineTexts, pages };
}

/** Where a page sits in the watch list: after earlier checks, before later ones. */
function pageInsertionIndex(anchors: readonly (number | undefined)[], pageIndex: number): number {
  let at = 0;
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index];
    if (anchor === undefined || anchor < pageIndex) {
      at = index + 1;
      continue;
    }
    if (anchor > pageIndex) return Math.min(at, index);
  }
  return at;
}

/**
 * Watch checks stay in acceptance order. Each check anchors to the latest remaining read of that
 * text, so a repeated watch stays after the page between the two reads. Page reads land at their
 * transcript position so an older page cannot evict a newer watch, and the reverse.
 */
function chronologicalOutsideText(
  messages: readonly AgentMessage[],
  watchEntries: readonly string[],
  contextStrategy?: AgentContextStrategy,
): string {
  const { routineTexts, pages } = scanOutsideSources(messages, contextStrategy);
  const anchors = new Array<number | undefined>(watchEntries.length);
  const routineIndexes = [...routineTexts.keys()];
  for (let entryIndex = watchEntries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = watchEntries[entryIndex]!;
    for (let cursor = routineIndexes.length - 1; cursor >= 0; cursor -= 1) {
      const index = routineIndexes[cursor]!;
      const counts = routineTexts.get(index)!;
      const count = counts.get(entry) ?? 0;
      if (count <= 0) continue;
      if (count === 1) counts.delete(entry);
      else counts.set(entry, count - 1);
      anchors[entryIndex] = index;
      break;
    }
  }
  const events: Array<{ pos: number; text: string }> = watchEntries.map((text, index) => ({
    pos: index,
    text,
  }));
  for (const page of pages) {
    events.push({ pos: pageInsertionIndex(anchors, page.index) - 0.5, text: page.text });
  }
  events.sort((left, right) => left.pos - right.pos);
  let kept = "";
  for (const event of events) kept = appendOutsideText(kept, event.text);
  return kept;
}

function restoredStatePrefix(
  stateMessages: readonly AgentMessage[],
  restoredMessages: readonly Message[] | undefined,
): number {
  if (!restoredMessages?.length) return 0;
  const offset =
    stateMessages[0]?.role === "system" && restoredMessages[0]?.role !== "system" ? 1 : 0;
  return restoredMessages.length + offset;
}

/** Provenance fields belong to one delivery. A slice must not inherit another slice's texts. */
function cleanWatchDetails(details: Record<string, unknown>): Record<string, unknown> {
  const { contextBeforeUseText: _beforeUse, contextDeliveredTexts: _delivered, ...clean } = details;
  return clean;
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
  /** Chronological outside tail from the checkpoint this run resumed. */
  priorOutsideText?: string;
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
  // Acceptance order: earlier evidence, then this turn's slices, then a watch result the model
  // has not been shown yet. The newest tail stays inside MAX_OUTSIDE_TEXT_CHARS.
  const orderedWatch: string[] = [];
  let retainedBaseline = 0;
  for (const entry of input.priorWatchOutsideText ?? []) {
    if (entry.trim()) orderedWatch.push(entry);
  }
  const priorCount = orderedWatch.length;
  const restoredRetained = new Set<AgentMessage>();
  const restoredRoutineCallIds = new Set<string>();
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
      const restoredItems = watchTextValues(message, input.contextStrategy);
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
        // Already saved in acceptance order. Re-extracting a dropped result moves it to the end.
        if (input.priorWatchOutsideText === undefined) orderedWatch.push(...restoredItems);
        else restoredRoutineCallIds.add(message.toolCallId);
        continue;
      }
      restoredRetained.add(retainedMatch);
      if (input.priorWatchOutsideText !== undefined) {
        restoredRoutineCallIds.add(message.toolCallId);
        continue;
      }
      const retainedSet = new Set(watchTextValues(retainedMatch, input.contextStrategy));
      for (const value of restoredItems) {
        if (!retainedSet.has(value)) orderedWatch.push(value);
        else if (input.priorWatchOutsideText === undefined) {
          // A resumed checkpoint with no watch list still keeps this text on the message.
          // Copy it only when this turn also records other watch evidence.
          orderedWatch.push(value);
          retainedBaseline += 1;
        }
      }
    }
  }
  const acceptedWatch: string[] = [];
  const coveredWatch = new Set<AgentMessage>();
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
    slices.sort((left, right) => left.order - right.order || left.index - right.index);
    for (const slice of slices) {
      if (!slice.text.trim()) continue;
      if (slice.retainedAt !== undefined) {
        const retained = messages[slice.retainedAt];
        if (retained) coveredWatch.add(retained);
      }
      const firstSlice = slice.entry.full || slice.index === 0;
      const details = cleanWatchDetails(slice.entry.details);
      const synthetic = firstSlice
        ? {
            details: { ...details, contextBeforeUseText: slice.text },
            content: [{ type: "text" as const, text: slice.text }],
          }
        : {
            details: {
              ...details,
              contextBeforeUseText: EMPTY_WATCH_DELIVERY,
              contextDeliveredTexts: [slice.text],
            },
            content: [{ type: "text" as const, text: EMPTY_WATCH_DELIVERY }],
          };
      acceptedWatch.push(...watchTextValues(synthetic, input.contextStrategy));
    }
  }
  const unseenWatch: string[] = [];
  for (const message of messages) {
    if (
      message.role !== "toolResult" ||
      !isRecord(message.details) ||
      !("routines" in message.details) ||
      coveredWatch.has(message) ||
      restoredRetained.has(message) ||
      (input.priorWatchOutsideText !== undefined && restoredRoutineCallIds.has(message.toolCallId))
    )
      continue;
    unseenWatch.push(...watchTextValues(message, input.contextStrategy));
  }
  const onlyRetainedBaseline =
    input.priorWatchOutsideText === undefined &&
    acceptedWatch.length === 0 &&
    unseenWatch.length === 0 &&
    retainedBaseline > 0 &&
    orderedWatch.length - priorCount === retainedBaseline;
  const watchOutsideText = boundWatchOutsideText(
    dedupeLatestWatchText(
      onlyRetainedBaseline ? [] : [...orderedWatch, ...acceptedWatch, ...unseenWatch],
    ),
  );
  const outsideText = checkpointOutsideText({
    stateMessages: input.stateMessages,
    restoredMessages: input.restoredMessages,
    watchOutsideText,
    priorOutsideText: input.priorOutsideText,
    freshWatch: [...acceptedWatch, ...unseenWatch],
    contextStrategy: input.contextStrategy,
  });
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
    ...(watchOutsideText.length > 0 ? { watchOutsideText } : {}),
    ...(outsideText ? { outsideText } : {}),
  };
}

function checkpointOutsideText(input: {
  stateMessages: readonly AgentMessage[];
  restoredMessages?: readonly Message[];
  watchOutsideText: readonly string[];
  priorOutsideText?: string;
  freshWatch: readonly string[];
  contextStrategy?: AgentContextStrategy;
}): string | undefined {
  const prior = input.priorOutsideText?.trim() ? input.priorOutsideText : undefined;
  if (prior) {
    const prefix = restoredStatePrefix(input.stateMessages, input.restoredMessages);
    // A new read after the restored prefix stays, even when its text matches an older check.
    const freshWatch = input.freshWatch.filter((entry) => entry.trim());
    const addition = chronologicalOutsideText(
      input.stateMessages.slice(prefix),
      freshWatch,
      input.contextStrategy,
    );
    const text = addition ? appendOutsideText(prior, addition) : prior;
    return text.trim() ? text : undefined;
  }
  if (input.watchOutsideText.length === 0) return undefined;
  if (scanOutsideSources(input.stateMessages, input.contextStrategy).pages.length === 0) {
    return undefined;
  }
  const text = chronologicalOutsideText(
    input.stateMessages,
    input.watchOutsideText,
    input.contextStrategy,
  );
  return text.trim() ? text : undefined;
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
  return serializeTurnCheckpoint(checkpointWithSiblingWatchResults(checkpoint, siblings));
}

function appendMessageOutside(
  kept: string,
  message: Message,
  wrapped: ReadonlyMap<string, string>,
): string {
  if (message.role !== "toolResult" || checkpointOmitsToolResult(message.toolName)) return kept;
  const name = resolvedToolName(message, wrapped);
  if (isRoutineWatchName(name)) {
    return routineWatchTexts(message, wrapped).reduce(
      (text, entry) => appendOutsideText(text, entry),
      kept,
    );
  }
  if (!name || !toolResultTaintsRun(name)) return kept;
  return appendOutsideText(kept, message.content);
}

/** A page or other persisted outside result. Routine checks and stripped speech do not count. */
function persistsCheckpointOutside(
  message: Message,
  wrapped: ReadonlyMap<string, string>,
): boolean {
  if (message.role !== "toolResult" || checkpointOmitsToolResult(message.toolName)) return false;
  const name = resolvedToolName(message, wrapped);
  return Boolean(name && !isRoutineWatchName(name) && toolResultTaintsRun(name));
}

/**
 * A parallel sibling can finish after the last model delivery and never enter `watchDeliveries`.
 * When the checkpoint already lists watch checks, restore will not read routine results again,
 * so the sibling's checks have to be on that list. A checkpoint with no list keeps message
 * extraction, unless the sibling is the first watch evidence, in which case the list must also
 * hold the checks already stored on retained results. A page sibling on a watch-only checkpoint
 * starts the outside-text tail from the saved watch list, then appends the sibling in order.
 */
function checkpointWithSiblingWatchResults(
  checkpoint: TurnCheckpoint,
  siblings: readonly Message[],
): TurnCheckpoint {
  const messages = [...checkpoint.messages, ...siblings];
  const wrapped = wrappedToolNames(checkpoint.messages);
  const additions = siblings.flatMap((message) => routineWatchTexts(message, wrapped));
  const retainedWatch =
    checkpoint.watchOutsideText ??
    (additions.length > 0
      ? checkpoint.messages.flatMap((message) => routineWatchTexts(message, wrapped))
      : []);
  let outsideText = checkpoint.outsideText;
  const outsideSibling = siblings.some((message) => persistsCheckpointOutside(message, wrapped));
  if (!outsideText && outsideSibling && (retainedWatch.length > 0 || additions.length > 0)) {
    outsideText = retainedWatch.reduce((kept, entry) => appendOutsideText(kept, entry), "");
  }
  if (outsideText !== undefined && (checkpoint.outsideText || outsideSibling)) {
    for (const message of siblings)
      outsideText = appendMessageOutside(outsideText, message, wrapped);
  }
  if (additions.length === 0) {
    return { ...checkpoint, messages, ...(outsideText ? { outsideText } : {}) };
  }
  const seen = new Set(retainedWatch);
  const extra = additions.filter((text) => {
    if (seen.has(text)) return false;
    seen.add(text);
    return true;
  });
  const watchOutsideText = boundWatchOutsideText(
    extra.length > 0 ? [...retainedWatch, ...extra] : retainedWatch,
  );
  return {
    ...checkpoint,
    messages,
    ...(watchOutsideText.length > 0 ? { watchOutsideText } : {}),
    ...(outsideText ? { outsideText } : {}),
  };
}
