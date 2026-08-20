import type {
  ComputerStatus,
  MessageBlock,
  ProductEvent,
  ThreadMessage,
  ThreadMessagePage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import {
  appendTextSegment,
  appendToolCallSegment,
  endsSentence,
  mergeThreadHistory,
  prependThreadHistoryPage,
  progressMessageId,
  progressMessageText,
  subagentBlockFromPayload,
} from "@rakazo/core";

// reduceThreadSnapshot runs once per incoming event with no memory of its own beyond the
// `prev`/`next` snapshots, so a tool call held back mid-sentence (see flushPendingTools below)
// needs somewhere to live between calls. Keyed by run id; cleared once the run's durable
// message arrives.
const pendingToolsByRun = new Map<string, string[]>();

// If `tailText` (the narration not yet folded into `segments`) now ends a sentence, fold it in
// followed by every tool call held back since the sentence started, and return the result.
// Returns null when there's nothing pending or the sentence hasn't finished yet — the caller
// keeps waiting.
function flushPendingTools(
  liveId: string,
  segments: readonly MessageBlock[],
  tailText: string,
): MessageBlock[] | null {
  const pending = pendingToolsByRun.get(liveId);
  if (!pending || pending.length === 0 || !endsSentence(tailText)) return null;
  let next = appendTextSegment(segments, tailText);
  for (const name of pending) next = appendToolCallSegment(next, name);
  pendingToolsByRun.delete(liveId);
  return next;
}

function liveStreamTextSoFar(blocks: readonly MessageBlock[]): string {
  return blocks
    .filter((block) => block.kind === "text" || block.kind === "progress")
    .map((block) => (block.kind === "text" || block.kind === "progress" ? block.text : ""))
    .join("");
}

const computerStates: ReadonlySet<unknown> = new Set<ComputerStatus["state"]>([
  "stopped",
  "booting",
  "running",
  "suspended",
  "error",
]);

export function mergeThreadSnapshot(
  prev: ThreadSnapshot | null,
  next: ThreadSnapshot,
  preserveLoadedHistory = false,
): ThreadSnapshot {
  return mergeThreadHistory(prev, next, preserveLoadedHistory);
}

export function prependThreadMessagePage(
  prev: ThreadSnapshot | null,
  page: ThreadMessagePage,
): ThreadSnapshot | null {
  return prependThreadHistoryPage(prev, page);
}

export function isThreadSnapshotEvent(event: ProductEvent): boolean {
  return (
    event.type === "thread.cleared" ||
    event.type === "thread.progress" ||
    event.type === "thread.subagent" ||
    event.type === "agent.tool.called" ||
    event.type === "thread.message.created" ||
    event.type === "thread.message.updated" ||
    event.type === "run.waiting_input"
  );
}

export function reduceThreadSnapshot(
  prev: ThreadSnapshot | null,
  event: ProductEvent,
): ThreadSnapshot | null {
  if (!prev) return prev;
  if (event.type === "thread.cleared") {
    return { ...prev, cursor: event.seq, messages: [], olderCursor: null, run: null };
  }
  if (event.type === "run.waiting_input") {
    const run = prev.run;
    if (!run || run.id !== event.runId || run.status === "waiting_input") return prev;
    return {
      ...prev,
      cursor: event.seq,
      run: { ...run, status: "waiting_input" },
    };
  }
  if (event.type === "thread.progress") {
    const liveId = progressMessageId(event);
    const previous = prev.messages.find((message) => message.id === liveId);
    const priorBlocks = previous?.blocks ?? [];
    const flushedBlocks =
      priorBlocks.at(-1)?.kind === "progress" ? priorBlocks.slice(0, -1) : priorBlocks;
    // Deltas are relative to the whole stream so far, not just the unflushed tail — reconstruct
    // the full text, then take only what's beyond what earlier segments already captured.
    const flushedLength = liveStreamTextSoFar(flushedBlocks).length;
    const fullText = progressMessageText(event.payload, liveStreamTextSoFar(priorBlocks));
    const tailText = fullText.slice(flushedLength);
    const blocks =
      flushPendingTools(liveId, flushedBlocks, tailText) ??
      (tailText
        ? [...flushedBlocks, { kind: "progress" as const, text: tailText }]
        : flushedBlocks);
    const streaming: ThreadMessage = {
      id: liveId,
      threadId: event.threadId,
      seq: event.seq,
      role: "bot",
      blocks,
      runId: event.runId,
      createdAt: event.createdAt,
    };
    const without = prev.messages.filter((message) => !message.id.startsWith("progress:"));
    return { ...prev, cursor: event.seq, messages: [...without, streaming] };
  }
  if (event.type === "agent.tool.called") {
    const liveId = progressMessageId(event);
    const previous = prev.messages.find((message) => message.id === liveId);
    const priorBlocks = previous?.blocks ?? [];
    const tail = priorBlocks.at(-1);
    const tailText = tail?.kind === "progress" ? tail.text : "";
    const flushedBlocks = tail?.kind === "progress" ? priorBlocks.slice(0, -1) : priorBlocks;
    const pending = pendingToolsByRun.get(liveId) ?? [];
    pending.push(String(event.payload.name ?? ""));
    pendingToolsByRun.set(liveId, pending);
    const blocks =
      flushPendingTools(liveId, flushedBlocks, tailText) ??
      (tailText
        ? [...flushedBlocks, { kind: "progress" as const, text: tailText }]
        : flushedBlocks);
    const next: ThreadMessage = {
      id: liveId,
      threadId: event.threadId,
      seq: event.seq,
      role: "bot",
      blocks,
      runId: event.runId,
      createdAt: event.createdAt,
    };
    const without = prev.messages.filter((message) => message.id !== liveId);
    return { ...prev, cursor: event.seq, messages: [...without, next] };
  }
  if (event.type === "thread.subagent") {
    const block = subagentBlockFromPayload(event.payload);
    const next: ThreadMessage = {
      id: `subagent:${block.agentId}`,
      threadId: event.threadId,
      seq: event.seq,
      role: "bot",
      blocks: [block],
      runId: event.runId,
      createdAt: event.createdAt,
    };
    const without = prev.messages.filter(
      (message) =>
        message.id !== next.id &&
        !message.id.startsWith("progress:") &&
        !message.id.startsWith("steps:"),
    );
    const kept = prev.messages.filter(
      (message) => message.id.startsWith("progress:") || message.id.startsWith("steps:"),
    );
    return { ...prev, cursor: event.seq, messages: [...without, next, ...kept] };
  }
  if (event.type === "thread.message.created" || event.type === "thread.message.updated") {
    pendingToolsByRun.delete(progressMessageId(event));
    const role = (event.payload.role as ThreadMessage["role"]) ?? "bot";
    const blocks = (event.payload.blocks as ThreadMessage["blocks"]) ?? [];
    const next: ThreadMessage = {
      id: String(event.payload.messageId ?? event.id),
      threadId: event.threadId,
      seq: event.seq,
      role,
      blocks,
      runId: event.runId,
      createdAt: event.createdAt,
    };
    const replacedSubagentIds = new Set(
      blocks.filter((block) => block.kind === "subagent").map((block) => block.agentId),
    );
    const without = prev.messages.filter(
      (message) =>
        message.id !== next.id &&
        !message.id.startsWith("progress:") &&
        !message.id.startsWith("steps:") &&
        !replacedSubagent(message, replacedSubagentIds),
    );
    return { ...prev, cursor: event.seq, messages: [...without, next] };
  }
  return prev;
}

export function reduceComputerStatus(
  prev: ComputerStatus | null,
  event: ProductEvent,
): ComputerStatus | null {
  if (!prev) return prev;
  if (!isComputerStatusEvent(event)) return prev;
  if (event.type === "computer.takeover.granted") {
    return prev.controlHolder === "user" ? prev : { ...prev, controlHolder: "user" };
  }
  if (event.type === "computer.takeover.released") {
    const holder = event.payload.holder;
    if (holder !== "bot" && holder !== "none") return prev;
    return prev.controlHolder === holder ? prev : { ...prev, controlHolder: holder };
  }
  const status = event.payload.status;
  if (!isComputerState(status)) return prev;
  const screenAvailable = status === "running" || status === "booting" || prev.screenAvailable;
  if (status === prev.state && screenAvailable === prev.screenAvailable) return prev;
  return {
    ...prev,
    state: status,
    screenAvailable,
  };
}

export function isComputerStatusEvent(event: ProductEvent): boolean {
  return (
    event.type === "computer.status" ||
    event.type === "computer.takeover.granted" ||
    event.type === "computer.takeover.released"
  );
}

function isComputerState(value: unknown): value is ComputerStatus["state"] {
  return computerStates.has(value);
}

function replacedSubagent(message: ThreadMessage, agentIds: ReadonlySet<string>) {
  if (agentIds.size === 0) return false;
  return message.blocks.some((block) => block.kind === "subagent" && agentIds.has(block.agentId));
}
