import type { ThreadMessage } from "@rakazo/contracts";

/** A text send shown in its chat before its stored message arrives. */
export type PendingSend = {
  /** The bot or group id the send went to. */
  threadKey: string;
  clientNonce: string;
  text: string;
  /** The chat's newest message seq when the send began. */
  afterSeq: number;
  /** The message seq the server returned; the stored message carries it. */
  acceptedSeq?: number;
  replyToMessageId?: string;
  replyQuote?: string;
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

/** Rows built from live events carry an event seq, or none, rather than a message seq. */
const LIVE_ROW_PREFIXES = ["progress:", "subagent:", PENDING_ID_PREFIX];

/** The newest stored message seq in a chat, the baseline a pending send compares against. */
export function newestMessageSeq(messages: readonly ThreadMessage[]) {
  return messages.reduce(
    (max, message) =>
      Number.isFinite(message.seq) &&
      !LIVE_ROW_PREFIXES.some((prefix) => message.id.startsWith(prefix))
        ? Math.max(max, message.seq)
        : max,
    0,
  );
}

/** A direct chat stores the user's messages without an author; a group names who sent them. */
function sentBy(message: ThreadMessage, meId: string | undefined) {
  return message.role === "user" && (!message.author || message.author.id === meId);
}

/**
 * Pairs each pending send with its stored message, one message per send: by the seq the server
 * returned, or, while that answer is still on its way, by the same words from this user after the
 * send began (a live update can deliver the stored message before the send call returns).
 */
function unmatchedSends(
  messages: readonly ThreadMessage[],
  pending: readonly PendingSend[],
  meId: string | undefined,
) {
  const claimed = new Set<string>();
  const claim = (matches: (message: ThreadMessage) => boolean) => {
    const message = messages.find((candidate) => !claimed.has(candidate.id) && matches(candidate));
    if (message) claimed.add(message.id);
    return Boolean(message);
  };
  const confirmed = new Set(
    pending.filter(
      (send) =>
        send.acceptedSeq !== undefined && claim((message) => message.seq === send.acceptedSeq),
    ),
  );
  return pending.filter(
    (send) =>
      !confirmed.has(send) &&
      (send.acceptedSeq !== undefined ||
        !claim(
          (message) =>
            message.seq > send.afterSeq &&
            sentBy(message, meId) &&
            messageText(message) === send.text,
        )),
  );
}

/** The chat's messages with its pending sends shown last, each until its stored message arrives. */
export function withPendingSends(
  messages: ThreadMessage[],
  pending: readonly PendingSend[],
  threadKey: string | undefined,
  threadId: string | undefined,
  meId: string | undefined,
): ThreadMessage[] {
  const inChat = pending.filter((send) => send.threadKey === threadKey);
  if (!inChat.length || !threadId) return messages;
  const unmatched = unmatchedSends(messages, inChat, meId);
  if (!unmatched.length) return messages;
  let seq = newestMessageSeq(messages);
  const createdAt = new Date().toISOString();
  return [
    ...messages,
    ...unmatched.map((send) => ({
      id: `${PENDING_ID_PREFIX}${send.clientNonce}`,
      threadId,
      seq: ++seq,
      role: "user" as const,
      blocks: [{ kind: "text" as const, text: send.text }],
      ...(send.replyToMessageId ? { replyToMessageId: send.replyToMessageId } : {}),
      ...(send.replyQuote ? { replyQuote: send.replyQuote } : {}),
      createdAt,
    })),
  ];
}

/**
 * Pending sends without those the chat has caught up with: once it holds a message at or past a
 * send's stored seq, the stored message is in it or in older history it has not loaded.
 */
export function withoutDeliveredSends(
  pending: PendingSend[],
  messages: readonly ThreadMessage[],
  threadKey: string | undefined,
) {
  const newest = newestMessageSeq(messages);
  const next = pending.filter(
    (send) =>
      send.threadKey !== threadKey || send.acceptedSeq === undefined || newest < send.acceptedSeq,
  );
  return next.length === pending.length ? pending : next;
}
