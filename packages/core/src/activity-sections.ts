import type { RunActivityRow } from "@rakazo/contracts";
import { isRunWaitingOnUser, isRunWorking } from "./run-state.js";
import { isAgedStuckWork } from "./stuck-work.js";

type ActivityRun = Pick<RunActivityRow, "botId" | "groupId" | "status" | "updatedAt">;
type ActivityBot = { id: string; unread: boolean };
type ActivityGroup = { id: string; unread: boolean };

/** A question or forgotten queue wins over work, and an unread failure is something to look at. */
export function activityAttention(
  run: ActivityRun,
  unread = false,
): "needs_attention" | "working" | "unread" | null {
  if (isRunWaitingOnUser(run.status) || isAgedStuckWork(run.status, run.updatedAt))
    return "needs_attention";
  if (isRunWorking(run.status)) return "working";
  if (!unread) return null;
  return run.status === "failed" ? "needs_attention" : "unread";
}

const chatKey = (run: ActivityRun) => (run.groupId ? `group:${run.groupId}` : `bot:${run.botId}`);

/** Splits activity into what needs the user, what is running, unread chats, and the rest. */
export function activitySections<
  Run extends ActivityRun,
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
  const unreadChats = new Set([
    ...bots.filter((bot) => bot.unread).map((bot) => `bot:${bot.id}`),
    ...groups.filter((group) => group.unread).map((group) => `group:${group.id}`),
  ]);
  const runUnread = (run: Run) => unreadChats.has(chatKey(run));
  // Only a chat's latest outcome speaks for it; `recent` is newest first.
  const seen = new Set<string>();
  const latest = recent.filter((run) => !seen.has(chatKey(run)) && seen.add(chatKey(run)));
  const attention = [...active, ...latest].filter(
    (run) => activityAttention(run, runUnread(run)) === "needs_attention",
  );
  const working = active.filter(
    (run) => !attention.includes(run) && activityAttention(run) === "working",
  );
  const busy = new Set([...attention, ...working].map(chatKey));
  return {
    attention,
    working,
    unreadGroups: groups.filter((group) => group.unread && !busy.has(`group:${group.id}`)),
    unreadBots: bots.filter((bot) => bot.unread && !busy.has(`bot:${bot.id}`)),
    recent: recent.filter((run) => !attention.includes(run) && !runUnread(run)),
  };
}
