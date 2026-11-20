import type { ThreadMessage } from "@rakazo/contracts";

/** A text send shown in its chat before the server confirms it. */
export type PendingSend = {
  /** The bot or group id the send went to. */
  threadKey: string;
  clientNonce: string;
  text: string;
  /** The chat's newest message seq when the send began. */
  afterSeq: number;
  /** The message seq the server returned; the stored message carries it. */
  acceptedSeq?: number;
};

const PENDING_ID_PREFIX = "pending:";

export function isPendingSendMessage(message: Pick<ThreadMessage, "id">) {
  return message.id.startsWith(PENDING_ID_PREFIX);
}

function messageText(message: ThreadMessage) {
  return message.blocks
    .map((block) => (block.kind === "text" ? block.text : ""))
    .join("")
    .trim();
}

/** The newest message seq in a chat, the baseline a pending send compares against. */
export function newestMessageSeq(messages: readonly ThreadMessage[]) {
  return messages.reduce((max, message) => Math.max(max, message.seq), 0);
}

/**
 * Whether the stored message for a pending send has reached the chat: the seq the server
 * returned, or, while that answer is still on its way, the same words sent after the send began
 * (a live update can deliver the stored message before the send call returns).
 */
function echoed(messages: readonly ThreadMessage[], pending: PendingSend) {
  return messages.some((message) =>
    pending.acceptedSeq !== undefined
      ? message.seq === pending.acceptedSeq
      : message.role === "user" &&
        message.seq > pending.afterSeq &&
        messageText(message) === pending.text,
  );
}

/** The chat's messages with an unconfirmed send shown last, until its stored message arrives. */
export function withPendingSend(
  messages: ThreadMessage[],
  pending: PendingSend | null,
  threadKey: string | undefined,
  threadId: string | undefined,
): ThreadMessage[] {
  if (!pending || !threadId || pending.threadKey !== threadKey) return messages;
  if (echoed(messages, pending)) return messages;
  const lastSeq = newestMessageSeq(messages);
  return [
    ...messages,
    {
      id: `${PENDING_ID_PREFIX}${pending.clientNonce}`,
      threadId,
      seq: lastSeq + 1,
      role: "user",
      blocks: [{ kind: "text", text: pending.text }],
      createdAt: new Date().toISOString(),
    },
  ];
}
