import { sendEntrance } from "@rakazo/ui-tokens";

/** How long after a send its message may still arrive and enter with the send animation. */
export const SENT_ENTRANCE_WINDOW_MS = 15_000;

/** Your sent message rises from just above the composer into its place. */
export const SENT_ENTRANCE_KEYFRAMES: Keyframe[] = [
  { opacity: sendEntrance.opacity, transform: `translateY(${sendEntrance.offset}px)` },
  { opacity: 1, transform: "translateY(0)" },
];
export const SENT_ENTRANCE_TIMING: KeyframeAnimationOptions = {
  duration: sendEntrance.ms,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
};

interface EntranceMessage {
  id: string;
  role: string;
  author?: { id: string } | null;
  /** The message's written text, trimmed. */
  text?: string;
}

/** A send from this tab: when it was made and the text it carried. */
export interface PendingSend {
  sentAt: number;
  text?: string;
}

/**
 * The messages this tab just sent, on their first appearance: each send in this tab
 * (`pendingSends`, the times they were made) claims the first new message of yours appended
 * after everything already shown. History, older pages, other authors and bots never enter.
 */
export function sentMessageEntrances({
  messages,
  seenIds,
  pendingSends,
  meId,
  now,
}: {
  messages: readonly EntranceMessage[];
  seenIds: ReadonlySet<string>;
  pendingSends: readonly PendingSend[];
  meId: string | undefined;
  now: number;
}): { entering: string[]; pendingSends: PendingSend[] } {
  const pending = pendingSends.filter((send) => now - send.sentAt <= SENT_ENTRANCE_WINDOW_MS);
  const entering: string[] = [];
  if (!pending.length) return { entering, pendingSends: pending };
  // Only the tail after the last message already shown: an older page loads above it.
  let lastSeen = -1;
  messages.forEach((message, index) => {
    if (seenIds.has(message.id)) lastSeen = index;
  });
  // Your new messages after it. A snapshot that arrives while the chat loads can still carry
  // older ones, so each send claims the newest message that matches it.
  const candidates = messages
    .slice(lastSeen + 1)
    .filter(
      (message) =>
        !seenIds.has(message.id) &&
        message.role === "user" &&
        !(meId && message.author && message.author.id !== meId),
    );
  const stillPending: PendingSend[] = [];
  for (const send of pending) {
    // The same person writing from another tab sends other text, so it does not claim the send.
    const index = candidates.findLastIndex(
      (message) => send.text === undefined || (message.text ?? "") === send.text,
    );
    if (index < 0) {
      stillPending.push(send);
      continue;
    }
    entering.push(candidates[index]!.id);
    candidates.splice(index, 1);
  }
  return { entering, pendingSends: stillPending };
}

/** The pending sends after `count` new sends, each with its own text from `recentTexts`. */
export function withNewSends(
  pending: readonly PendingSend[],
  recentTexts: readonly string[],
  count: number,
  sentAt: number,
): PendingSend[] {
  return [...pending, ...recentTexts.slice(-Math.max(1, count)).map((text) => ({ sentAt, text }))];
}

/** The pending sends without those that produced no message, matched by their text. */
export function withoutUnsent(
  pending: readonly PendingSend[],
  unsentTexts: readonly string[],
): PendingSend[] {
  const next = [...pending];
  for (const text of unsentTexts) {
    const index = next.findLastIndex((send) => send.text === text);
    next.splice(index < 0 ? -1 : index, 1);
  }
  return next;
}
