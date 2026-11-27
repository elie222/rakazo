import { isRecord } from "@rakazo/core";

/** A transcript message with enough shape to recover a deferred `use_tool` name. */
type NamedMessage = {
  role: string;
  toolName?: string;
  toolCallId?: string;
  content?: unknown;
};

type ToolCallPart = {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
};

/**
 * Remember `use_tool` targets in call order. A later call that reuses an id replaces the previous
 * target, and any other call with that id clears it, so each result sees the call that produced it.
 */
export function noteWrappedToolCalls(message: NamedMessage, wrapped: Map<string, string>): void {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return;
  for (const part of message.content as ToolCallPart[]) {
    if (part?.type !== "toolCall" || typeof part.id !== "string") continue;
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

export function resolvedToolName(
  message: NamedMessage,
  wrapped: ReadonlyMap<string, string>,
): string | undefined {
  if (message.role !== "toolResult" || typeof message.toolName !== "string") return undefined;
  return message.toolName === "use_tool" ? wrapped.get(message.toolCallId ?? "") : message.toolName;
}

export function isRoutineWatchName(
  name: string | undefined,
): name is "schedule_list" | "task_catalog" {
  return name === "schedule_list" || name === "task_catalog";
}

/** The tool a call runs: what `use_tool` names, or the call's own name. */
export function calledToolName(
  call: { name?: unknown; arguments?: unknown } | undefined,
): string | undefined {
  if (typeof call?.name !== "string") return undefined;
  if (call.name !== "use_tool") return call.name;
  return isRecord(call.arguments) && typeof call.arguments.name === "string"
    ? call.arguments.name
    : undefined;
}

/** Resolved tool name of each message, using the `use_tool` call that preceded that result. */
export function toolNamesInOrder(messages: readonly NamedMessage[]): (string | undefined)[] {
  const wrapped = new Map<string, string>();
  return messages.map((message) => {
    noteWrappedToolCalls(message, wrapped);
    return resolvedToolName(message, wrapped);
  });
}

/**
 * Name of the result at `index`. A compacted copy can drop the assistant call, so prefer the
 * source transcript when `sourceIndexes` still points at it.
 */
export function routineToolNameAt(
  index: number,
  listedNames: readonly (string | undefined)[],
  stateNames: readonly (string | undefined)[],
  sourceIndexes: ReadonlyArray<number | undefined> | undefined,
): string | undefined {
  const sourceIndex = sourceIndexes?.[index];
  const fromState = sourceIndex !== undefined ? stateNames[sourceIndex] : undefined;
  return fromState ?? listedNames[index];
}
