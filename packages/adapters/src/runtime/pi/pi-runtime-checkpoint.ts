import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Context, Message } from "@earendil-works/pi-ai";
import type { AgentContextStrategy, AgentRunModel } from "@rakazo/adapter-kit";
import { watchChecksFromToolResultMessage } from "../../runs/assembly/watch-outside-text.js";
import type { ComputerModeCheckpoint, TurnCheckpoint } from "../../runs/turn/turn-checkpoint.js";
import {
  serializeTurnCheckpoint,
  unresolvedTurnCheckpointCalls,
} from "../../runs/turn/turn-checkpoint.js";
import type { WatchDeliveryState } from "../context/runtime-context.js";
import { computerSelection } from "./tools/pi-runtime-computer-mode.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  const isRetained = (entry: WatchDeliveryState) => {
    if (messageSourceIndexes !== undefined && entry.sourceIndex !== undefined) {
      return retainedWatchBySourceIndex.has(entry.sourceIndex);
    }
    return retainedWatch.some(
      (message) =>
        message.toolCallId === entry.toolCallId &&
        isRecord(message.details) &&
        message.details.routines === entry.details.routines,
    );
  };
  const droppedWatchOutside: string[] = [
    ...(input.priorWatchOutsideText ?? []).filter((entry) => entry.trim().length > 0),
  ];
  // Collect in chronological delivery order (prior dropped -> earlier restored -> current attempt)
  // so bounded outsideText retention (`MAX_OUTSIDE_TEXT_CHARS`) keeps the newest watch evidence.
  if (input.restoredMessages) {
    // Only results before the paused assistant turn in the restored checkpoint were actually
    // delivered to an earlier model; trailing sibling results await their first delivery.
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
          ? retainedWatchBySourceIndex.get(index)
          : retainedWatch.find(
              (retained) =>
                retained.toolCallId === message.toolCallId &&
                isRecord(retained.details) &&
                retained.details.routines === details.routines,
            );
      if (!retainedMatch) {
        droppedWatchOutside.push(...restoredItems);
        continue;
      }
      const retainedSet = new Set(
        watchChecksFromToolResultMessage(retainedMatch, input.contextStrategy).map((item) =>
          typeof item === "string" ? item : JSON.stringify(item),
        ),
      );
      for (const value of restoredItems) {
        if (!retainedSet.has(value)) droppedWatchOutside.push(value);
      }
    }
  }
  if (input.watchDeliveries) {
    for (const entry of input.watchDeliveries.values()) {
      if (isRetained(entry)) continue;
      const synthetic = entry.full
        ? {
            details: { ...entry.details, contextBeforeUseText: entry.fullText },
            content: [{ type: "text", text: entry.fullText }],
          }
        : {
            details: {
              ...entry.details,
              ...(entry.texts[0] !== undefined ? { contextBeforeUseText: entry.texts[0] } : {}),
              ...(entry.texts.length > 1 ? { contextDeliveredTexts: entry.texts } : {}),
            },
            content: [{ type: "text", text: entry.texts[0] ?? "" }],
          };
      for (const item of watchChecksFromToolResultMessage(synthetic, input.contextStrategy)) {
        const value = typeof item === "string" ? item : JSON.stringify(item);
        if (value.trim()) droppedWatchOutside.push(value);
      }
    }
  }
  const seenWatchOutside = new Set<string>();
  for (const entry of droppedWatchOutside) {
    seenWatchOutside.delete(entry);
    seenWatchOutside.add(entry);
  }
  const watchOutsideText = [...seenWatchOutside];
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
