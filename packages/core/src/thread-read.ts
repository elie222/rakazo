import type { ThreadReadState } from "@rakazo/contracts";
import { ThreadReadStateSchema } from "@rakazo/contracts";
import { isDurableMessage } from "./message-pages.js";

type PositionedMessage = { id: string; seq?: number };

/** Live progress uses event positions, which must never advance the message read cursor. */
export function durableMessageSeq(message: PositionedMessage): number | undefined {
  return isDurableMessage(message) &&
    typeof message.seq === "number" &&
    Number.isSafeInteger(message.seq) &&
    message.seq >= 0
    ? message.seq
    : undefined;
}

export function latestDurableMessageSeq(
  messages: readonly PositionedMessage[],
): number | undefined {
  let latest: number | undefined;
  for (const message of messages) {
    const seq = durableMessageSeq(message);
    if (seq !== undefined && (latest === undefined || seq > latest)) latest = seq;
  }
  return latest;
}

/** Manual unread reminders do not invent a message boundary for already-read history. */
export function unreadBoundary(readState?: ThreadReadState): number | null {
  return readState?.unread && readState.lastUnreadSeq > readState.lastReadSeq
    ? readState.lastReadSeq
    : null;
}

/** Use -1 only for a rendered empty transcript; undefined means nothing was viewed. */
export function threadReadAcknowledgement(
  readState: ThreadReadState | undefined,
  visibleSeq: number | undefined,
): number | undefined {
  if (!readState || visibleSeq === undefined) return;
  if (readState.unread && readState.lastUnreadSeq <= readState.lastReadSeq) {
    // A reminder may follow hidden history. Reaffirm the already-read position,
    // which cannot consume a newer message that arrives before this request commits.
    return Math.max(visibleSeq, readState.lastReadSeq);
  }
  return visibleSeq > readState.lastReadSeq ? visibleSeq : undefined;
}

/** Pass rendered messages in reading order and retain the boundary for the current visit. */
export function unreadDividerMessageId(
  messages: readonly PositionedMessage[],
  boundary: number | null,
  olderCursor: number | null,
): string | null {
  if (boundary === null || (olderCursor !== null && olderCursor > boundary + 1)) return null;
  return (
    messages.find((message) => {
      const seq = durableMessageSeq(message);
      return seq !== undefined && seq > boundary;
    })?.id ?? null
  );
}

export function threadReadStateFromPayload(
  payload?: Record<string, unknown>,
): ThreadReadState | undefined {
  const parsed = ThreadReadStateSchema.safeParse(payload?.readState);
  return parsed.success ? parsed.data : undefined;
}
