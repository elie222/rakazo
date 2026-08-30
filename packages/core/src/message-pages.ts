interface MessageIdentity {
  id: string;
  seq?: number;
}

export interface ThreadHistory<TMessage extends MessageIdentity> {
  threadId: string;
  messages: readonly TMessage[];
  olderCursor: number | null;
}

export function mergeThreadHistory<
  TMessage extends MessageIdentity,
  TSnapshot extends ThreadHistory<TMessage>,
>(previous: TSnapshot | null, recent: TSnapshot, preserveLoadedHistory = false): TSnapshot {
  if (!previous || previous.threadId !== recent.threadId || !preserveLoadedHistory) return recent;
  return {
    ...recent,
    messages: mergeMessagePages(previous.messages, recent.messages),
    olderCursor: previous.olderCursor,
  };
}

export function prependThreadHistoryPage<
  TMessage extends MessageIdentity,
  TSnapshot extends ThreadHistory<TMessage>,
>(previous: TSnapshot | null, page: ThreadHistory<TMessage>): TSnapshot | null {
  if (!previous || previous.threadId !== page.threadId || previous.olderCursor == null) {
    return previous;
  }
  return {
    ...previous,
    messages: mergeMessagesById(page.messages, previous.messages),
    olderCursor: page.olderCursor,
  };
}

export function mergeMessagePages<T extends MessageIdentity>(
  previous: readonly T[],
  recent: readonly T[],
): T[] {
  const firstRecentSeq = recent.reduce<number | null>((first, message) => {
    if (!isDurableMessage(message) || typeof message.seq !== "number") return first;
    return Math.min(first ?? message.seq, message.seq);
  }, null);
  const retained =
    firstRecentSeq === null
      ? []
      : previous.filter(
          (message) =>
            isDurableMessage(message) &&
            typeof message.seq === "number" &&
            message.seq < firstRecentSeq,
        );
  return mergeMessagesById(retained, recent);
}

export function mergeMessagesById<T extends { id: string }>(
  first: readonly T[],
  second: readonly T[],
): T[] {
  const seen = new Set<string>();
  return [...first, ...second].filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

export function upsertMessageById<T extends { id: string }>(messages: readonly T[], next: T): T[] {
  const index = messages.findIndex((message) => message.id === next.id);
  if (index < 0) return [...messages, next];
  const updated = [...messages];
  updated[index] = next;
  return updated;
}

function isDurableMessage(message: { id: string }): boolean {
  return !message.id.startsWith("progress:") && !message.id.startsWith("subagent:");
}
