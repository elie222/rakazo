import type { RunActivityRow } from "@rakazo/contracts";
import { isRunWaitingOnUser, isRunWorking } from "./run-state.js";

export type NotificationAttention = "needs_attention" | "working" | "unread";

/** A question wins over work, and unread is a receipt, not another running state. */
export function notificationAttention(
  status: string,
  unread = false,
  failed = false,
): NotificationAttention | null {
  if (isRunWaitingOnUser(status)) return "needs_attention";
  if (isRunWorking(status)) return "working";
  if ((status === "failed" || failed) && unread) return "needs_attention";
  return unread ? "unread" : null;
}

/** A conversation receipt must not promote every older failure into an interruption. */
export function notificationAttentionRuns(
  active: readonly RunActivityRow[],
  recent: readonly RunActivityRow[],
  bots: ReadonlyArray<{ id: string; unread: boolean; runErrorId?: string | null }>,
  groups: ReadonlyArray<{ id: string; unread: boolean }>,
): RunActivityRow[] {
  const latest = new Map<string, RunActivityRow>();
  for (const run of [...active, ...recent]) {
    const before = latest.get(run.threadId);
    if (!before || Date.parse(run.updatedAt) > Date.parse(before.updatedAt))
      latest.set(run.threadId, run);
  }
  return [...active, ...recent].filter((run) => {
    if (isRunWaitingOnUser(run.status)) return true;
    if (run.status !== "failed") return false;
    if (run.groupId)
      return (
        latest.get(run.threadId)?.runId === run.runId &&
        groups.some((group) => group.id === run.groupId && group.unread)
      );
    return bots.some((bot) => bot.id === run.botId && bot.unread && bot.runErrorId === run.runId);
  });
}
