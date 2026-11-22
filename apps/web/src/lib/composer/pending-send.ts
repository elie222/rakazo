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

/**
 * The newest message seq in a chat, the baseline a pending send compares against. Rows built
 * from live events can lack a seq, so only real numbers count.
 */
export function newestMessageSeq(messages: readonly ThreadMessage[]) {
  return messages.reduce(
    (max, message) => (Number.isFinite(message.seq) ? Math.max(max, message.seq) : max),
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
      createdAt,
    })),
  ];
}

/** Pending sends with those whose stored message the chat now shows removed. */
export function withoutDeliveredSends(
  pending: PendingSend[],
  messages: readonly ThreadMessage[],
  threadKey: string | undefined,
) {
  const next = pending.filter(
    (send) =>
      send.threadKey !== threadKey ||
      send.acceptedSeq === undefined ||
      !messages.some((message) => message.seq === send.acceptedSeq),
  );
  return next.length === pending.length ? pending : next;
}
