import type { Message } from "@earendil-works/pi-ai";
import type { AgentRunModel } from "@rakazo/adapter-kit";
import { withoutThinkingFrom } from "./thinking-signatures.js";

/** Internal, versioned transcript; never a client event payload. */
export interface TurnCheckpoint {
  version: 1;
  provider: string;
  model: string;
  systemPrompt: string;
  pendingToolCallId: string;
  messages: Message[];
  /** Only explicit sequential checkpoints guarantee an unstarted tail. */
  executionMode?: "parallel" | "sequential";
}

export function serializeTurnCheckpoint(checkpoint: TurnCheckpoint): string {
  return JSON.stringify(checkpoint);
}

export function restoreTurnCheckpoint(
  blob: string,
  model: Pick<AgentRunModel, "provider" | "id">,
): TurnCheckpoint {
  const checkpoint = JSON.parse(blob) as TurnCheckpoint;
  if (
    checkpoint.version !== 1 ||
    typeof checkpoint.systemPrompt !== "string" ||
    typeof checkpoint.provider !== "string" ||
    typeof checkpoint.model !== "string" ||
    typeof checkpoint.pendingToolCallId !== "string" ||
    !Array.isArray(checkpoint.messages)
  ) {
    throw new Error("Unsupported turn checkpoint");
  }
  const messages = [...checkpoint.messages];
  while (messages.at(-1)?.role === "assistant") {
    const tail = messages.at(-1)!;
    if (tail.role !== "assistant" || (tail.stopReason !== "aborted" && tail.stopReason !== "error"))
      break;
    messages.pop();
  }
  return {
    ...checkpoint,
    messages:
      checkpoint.provider === model.provider && checkpoint.model === model.id
        ? messages
        : withoutThinkingFrom(messages, 0),
  };
}
