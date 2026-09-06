import type { MessageBlock } from "@rakazo/contracts";
import { cloudAgentBlockFromPayload } from "./cloud-agent.js";

/** Remove this run's live message and obsolete unscoped progress without reordering history. */
export function takeLiveMessage<Message extends { id: string; runId?: string | null }>(
  messages: readonly Message[],
  liveId: string,
): { previous: Message | undefined; remaining: Message[] } {
  let previous: Message | undefined;
  const remaining: Message[] = [];
  for (const message of messages) {
    if (message.id === liveId) previous = message;
    else if (!message.id.startsWith("progress:") || message.runId) remaining.push(message);
  }
  return { previous, remaining };
}

export function updateCloudAgentMessages<Message extends { id: string; blocks: MessageBlock[] }>(
  messages: readonly Message[],
  payload: Record<string, unknown>,
): Message[] {
  const agentId = String(payload.agentId ?? "");
  const messageId = String(payload.messageId ?? "");
  const block = cloudAgentBlockFromPayload(payload);
  return messages.map((message) => {
    if (
      (messageId && message.id === messageId) ||
      message.blocks.some(
        (existing) => existing.kind === "cloud_agent" && existing.agentId === agentId,
      )
    ) {
      return {
        ...message,
        blocks: message.blocks.map((existing) =>
          existing.kind === "cloud_agent" && existing.agentId === agentId ? block : existing,
        ),
      };
    }
    return message;
  });
}

export function updateMessageReaction<Message extends { id: string }>(
  messages: readonly Message[],
  payload: Record<string, unknown>,
): Message[] {
  const messageId = String(payload.messageId ?? "");
  return messages.map((message) =>
    message.id === messageId ? { ...message, thumbsUp: payload.thumbsUp === true } : message,
  );
}
