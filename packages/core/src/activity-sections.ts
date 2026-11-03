import type { RunActivityRow } from "@rakazo/contracts";
import { isRunWaitingOnUser, isRunWorking } from "./run-state.js";

type ActivityBot = { id: string; status: string; unread: boolean; runErrorId?: string | null };
type ActivityGroup = { id: string; unread: boolean };

/** A question wins over work, and an unread failure is something to look at, not a receipt. */
export function activityAttention(
  status: string,
  unread = false,
  failed = false,
): "needs_attention" | "working" | "unread" | null {
  if (isRunWaitingOnUser(status)) return "needs_attention";
  if (isRunWorking(status)) return "working";
  if (!unread) return null;
  return status === "failed" || failed ? "needs_attention" : "unread";
}

/** Splits activity into what needs the user, what is running, unread chats, and the rest. */
export function activitySections<
  Run extends Pick<RunActivityRow, "botId" | "groupId" | "status">,
  Bot extends ActivityBot,
  Group extends ActivityGroup,
>({
  active,
  recent,
  bots,
  groups,
}: {
  active: readonly Run[];
  recent: readonly Run[];
  bots: readonly Bot[];
  groups: readonly Group[];
}) {
  const unreadBotIds = new Set(bots.filter((bot) => bot.unread).map((bot) => bot.id));
  const unreadGroupIds = new Set(groups.filter((group) => group.unread).map((group) => group.id));
  const runUnread = (run: Run) =>
    run.groupId ? unreadGroupIds.has(run.groupId) : unreadBotIds.has(run.botId);
  const attention = [...active, ...recent].filter(
    (run) => activityAttention(run.status, runUnread(run)) === "needs_attention",
  );
  const working = active.filter((run) => isRunWorking(run.status));
  const busyGroupIds = new Set([...attention, ...working].map((run) => run.groupId));
  return {
    attention,
    working,
    unreadGroups: groups.filter((group) => group.unread && !busyGroupIds.has(group.id)),
    unreadBots: bots.filter(
      (bot) => activityAttention(bot.status, bot.unread, Boolean(bot.runErrorId)) === "unread",
    ),
    recent: recent.filter((run) => !attention.includes(run) && !runUnread(run)),
  };
}
