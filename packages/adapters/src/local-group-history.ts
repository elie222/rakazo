/** Keep parallel group assignments scoped to the active user's goal.
 * Before this, a teammate could accidentally research unrelated files from
 * an earlier user request in the same group thread. */
export function isGroupGoalScopedRun(
  clientNonce: string | null | undefined,
  taskPrompt: string,
): boolean {
  return Boolean(
    clientNonce?.startsWith("local-group-team:") ||
      (clientNonce?.startsWith("local-agent-goal:") &&
        taskPrompt.startsWith("[Internal group coordination")),
  );
}

export function scopeToGroupGoal<T extends { seq: number }>(
  messages: readonly T[],
  startSeq: number,
): T[] {
  // Messages are normally newest-first. Filtering retains their original order.
  return messages.filter((m) => m.seq >= startSeq);
}

/** Identify roots of peer assignments and owner syntheses without accepting
 * arbitrary local-agent-goal prefixes or malformed nonces. */
export function groupGoalRootId(clientNonce: string | null | undefined): string | null {
  const peer = clientNonce?.match(/^local-group-team:([a-z0-9]+):[a-z0-9]+$/);
  if (peer) return peer[1] ?? null;
  const assessment = clientNonce?.match(/^local-agent-goal:([a-z0-9]+):\\d+$/);
  return assessment?.[1] ?? null;
}

/** Reintroduce the specific originating user request if the rolling history
 * window has advanced beyond it. The request stays oldest in newest-first data. */
export function scopeToGroupGoalWithSource<T extends { seq: number }>(
  messages: readonly T[],
  startSeq: number,
  sourceMessage: T | null,
): T[] {
  const scoped = scopeToGroupGoal(messages, startSeq);
  if (
    sourceMessage &&
    sourceMessage.seq === startSeq &&
    !scoped.some((message) => message.seq === startSeq)
  ) {
    return [...scoped, sourceMessage];
  }
  return scoped;
}
