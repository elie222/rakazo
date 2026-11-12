/** How long after a send its message may still arrive and enter with the send animation. */
export const SENT_ENTRANCE_WINDOW_MS = 15_000;

/** Your sent message rises from just above the composer into its place. */
export const SENT_ENTRANCE_KEYFRAMES: Keyframe[] = [
  { opacity: 0.4, transform: "translateY(20px)" },
  { opacity: 1, transform: "translateY(0)" },
];
export const SENT_ENTRANCE_TIMING: KeyframeAnimationOptions = {
  duration: 250,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
};

interface EntranceMessage {
  id: string;
  role: string;
  author?: { id: string } | null;
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
  pendingSends: readonly number[];
  meId: string | undefined;
  now: number;
}): { entering: string[]; pendingSends: number[] } {
  const pending = pendingSends.filter((sentAt) => now - sentAt <= SENT_ENTRANCE_WINDOW_MS);
  const entering: string[] = [];
  if (!pending.length) return { entering, pendingSends: pending };
  // Only the tail after the last message already shown: an older page loads above it.
  let lastSeen = -1;
  messages.forEach((message, index) => {
    if (seenIds.has(message.id)) lastSeen = index;
  });
  for (const message of messages.slice(lastSeen + 1)) {
    if (!pending.length) break;
    if (seenIds.has(message.id) || message.role !== "user") continue;
    if (meId && message.author && message.author.id !== meId) continue;
    pending.shift();
    entering.push(message.id);
  }
  return { entering, pendingSends: pending };
}
