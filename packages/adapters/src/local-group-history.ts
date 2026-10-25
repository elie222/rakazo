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
