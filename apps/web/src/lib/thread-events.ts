import type {
  ComputerStatus,
  ProductEvent,
  ThreadMessage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { progressMessageId, progressMessageText, subagentBlockFromPayload } from "@rakazo/core";

const computerStates: ReadonlySet<unknown> = new Set<ComputerStatus["state"]>([
  "stopped",
  "booting",
  "running",
  "suspended",
  "error",
]);

export function reduceThreadSnapshot(
  prev: ThreadSnapshot | null,
  event: ProductEvent,
): ThreadSnapshot | null {
  if (!prev) return prev;
  if (event.type === "thread.progress") {
    const progressId = progressMessageId(event);
    const previous = prev.messages.find((message) => message.id === progressId);
    const previousText = previous?.blocks[0]?.kind === "progress" ? previous.blocks[0].text : "";
    const text = progressMessageText(event.payload, previousText);
    const streaming: ThreadMessage = {
      id: progressId,
      threadId: event.threadId,
      seq: event.seq,
      role: "bot",
      blocks: [{ kind: "progress", text }],
      runId: event.runId,
      createdAt: event.createdAt,
    };
    const without = prev.messages.filter((message) => !message.id.startsWith("progress:"));
    return { ...prev, cursor: event.seq, messages: [...without, streaming] };
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
      (message) => message.id !== next.id && !message.id.startsWith("progress:"),
    );
    const progress = prev.messages.filter((message) => message.id.startsWith("progress:"));
    return { ...prev, cursor: event.seq, messages: [...without, next, ...progress] };
  }
  if (event.type === "thread.message.created") {
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
  if (event.type !== "computer.status" && event.type !== "computer.takeover.granted") return prev;
  if (event.type === "computer.takeover.granted") {
    return prev.controlHolder === "user" ? prev : { ...prev, controlHolder: "user" };
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

function isComputerState(value: unknown): value is ComputerStatus["state"] {
  return computerStates.has(value);
}

function replacedSubagent(message: ThreadMessage, agentIds: ReadonlySet<string>) {
  if (agentIds.size === 0) return false;
  return message.blocks.some((block) => block.kind === "subagent" && agentIds.has(block.agentId));
}
