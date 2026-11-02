import type { Bot, Group, RunActivityRow } from "@rakazo/contracts";
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

type ActivityBot = Pick<Bot, "id" | "status" | "unread"> &
  Partial<Pick<Bot, "threadId" | "runErrorId" | "activeRunThreadId">>;
type ActivityGroup = Pick<Group, "id" | "unread">;

/** Shared activity policy; a surface may narrow the visible rows without changing their meaning. */
export function notificationActivity<B extends ActivityBot, G extends ActivityGroup>(
  active: readonly RunActivityRow[],
  recent: readonly RunActivityRow[],
  bots: readonly B[],
  groups: readonly G[],
  visible?: {
    active: readonly RunActivityRow[];
    recent: readonly RunActivityRow[];
    bots: readonly B[];
    groups: readonly G[];
  },
) {
  const view = visible ?? { active, recent, bots, groups };
  const attentionIds = new Set(
    notificationAttentionRuns(active, recent, bots, groups).map((run) => run.runId),
  );
  const attentionRuns = [...view.active, ...view.recent].filter((run) =>
    attentionIds.has(run.runId),
  );
  const workingRuns = view.active.filter((run) => notificationAttention(run.status) === "working");
  const attentionBots = view.bots.filter(
    (bot) =>
      (!bot.activeRunThreadId || bot.activeRunThreadId === bot.threadId) &&
      notificationAttention(bot.status, bot.unread, Boolean(bot.runErrorId)) ===
        "needs_attention" &&
      !attentionRuns.some((run) => !run.groupId && run.botId === bot.id),
  );
  const unreadBots = view.bots.filter(
    (bot) => notificationAttention(bot.status, bot.unread, Boolean(bot.runErrorId)) === "unread",
  );
  const unreadGroups = view.groups.filter(
    (group) =>
      group.unread && ![...attentionRuns, ...workingRuns].some((run) => run.groupId === group.id),
  );
  const readRecent = view.recent.filter(
    (run) =>
      !attentionIds.has(run.runId) &&
      !(run.groupId
        ? unreadGroups.some((group) => group.id === run.groupId)
        : [...unreadBots, ...attentionBots].some((bot) => bot.id === run.botId)),
  );
  return { attentionRuns, workingRuns, attentionBots, unreadBots, unreadGroups, readRecent };
}
