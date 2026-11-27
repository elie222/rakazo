import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Context, Message } from "@earendil-works/pi-ai";
import type { AgentRunModel } from "@rakazo/adapter-kit";
import type { ComputerModeCheckpoint, TurnCheckpoint } from "../../runs/turn/turn-checkpoint.js";
import {
  serializeTurnCheckpoint,
  unresolvedTurnCheckpointCalls,
} from "../../runs/turn/turn-checkpoint.js";
import { historyImageSeenNote, historyImageSeenStamp } from "../context/history-replay.prompt.js";
import { HISTORY_FORMAT_VERSION } from "./pi-runtime-history.js";
import { computerSelection } from "./tools/pi-runtime-computer-mode.js";

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
  sentContext?: { context: Context; sourceLength: number };
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
}): TurnCheckpoint {
  const messages = input.sentContext
    ? [
        ...input.sentContext.context.messages,
        ...input.stateMessages.slice(input.sentContext.sourceLength),
      ]
    : [...input.stateMessages];
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
    historyFormat: HISTORY_FORMAT_VERSION,
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

const IMAGE_SEEN_HISTORY_FORMAT = 4;

/** Upgrade replayed history without changing the prompt or messages added during this turn. */
export function upgradeCheckpointHistory(checkpoint: TurnCheckpoint): TurnCheckpoint {
  if ((checkpoint.historyFormat ?? 0) >= IMAGE_SEEN_HISTORY_FORMAT) return checkpoint;
  const messages = checkpoint.messages.map((message) => {
    const tagged = message as Message & { rakazoHistory?: boolean; rakazoCreatedAt?: string };
    if (message.role !== "user" || !tagged.rakazoHistory || !Array.isArray(message.content))
      return message;
    if (!message.content.some((part) => part.type === "image")) return message;
    if (
      message.content.some(
        (part) =>
          part.type === "text" &&
          /\[(?:\d{4}-\d{2}-\d{2} \d{2}:\d{2}, )?image from an earlier message; already seen\]/.test(
            part.text,
          ),
      )
    )
      return message;
    const timestamp = message.timestamp;
    const createdAt =
      tagged.rakazoCreatedAt ??
      (Number.isFinite(timestamp) && !Number.isNaN(new Date(timestamp).getTime()) && timestamp !== 0
        ? new Date(timestamp).toISOString()
        : undefined);
    const note = historyImageSeenNote(historyImageSeenStamp(createdAt));
    const [first, ...rest] = message.content;
    const content =
      first?.type === "text"
        ? [{ ...first, text: first.text.trim() ? `${note}\n${first.text}` : note }, ...rest]
        : [{ type: "text" as const, text: note }, ...message.content];
    return { ...message, content };
  });
  return { ...checkpoint, messages };
}
