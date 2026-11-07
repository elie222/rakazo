import { createChatQueues } from "./unread-divider.js";

/**
 * A snoozed chat leaves the viewer's list until its wake time, then returns marked as woken
 * until they open it. A bot waiting on an answer stays snoozed: its question was usually there
 * when the viewer snoozed it.
 */
type SnoozableChat = { snoozedUntil?: string | null };

function wakeTime(chat: SnoozableChat): number | null {
  if (!chat.snoozedUntil) return null;
  const time = Date.parse(chat.snoozedUntil);
  return Number.isNaN(time) ? null : time;
}

/** Hidden from the list: snoozed into the future. */
export function chatSnoozed(chat: SnoozableChat, now: number): boolean {
  const wake = wakeTime(chat);
  return wake !== null && wake > now;
}

/** Back in the list after its snooze ended, until the viewer opens it. */
export function chatWoke(chat: SnoozableChat, now: number): boolean {
  const wake = wakeTime(chat);
  return wake !== null && wake <= now;
}

/** The next moment one of these chats wakes, so a list can redraw then. */
export function nextChatWake(chats: Iterable<SnoozableChat>, now: number): number | null {
  let next: number | null = null;
  for (const chat of chats) {
    const wake = wakeTime(chat);
    if (wake !== null && wake > now && (next === null || wake < next)) next = wake;
  }
  return next;
}

export type SnoozePreset = "hour" | "threeHours" | "tomorrow" | "nextWeek";
export const SNOOZE_PRESETS: readonly SnoozePreset[] = [
  "hour",
  "threeHours",
  "tomorrow",
  "nextWeek",
];

const MORNING_HOUR = 9;

/** When a preset wakes, in the device's time zone: mornings at 9, next week on Monday. */
export function snoozePresetTime(preset: SnoozePreset, now: Date): Date {
  if (preset === "hour") return new Date(now.getTime() + 60 * 60 * 1000);
  if (preset === "threeHours") return new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const wake = new Date(now);
  wake.setHours(MORNING_HOUR, 0, 0, 0);
  const days = preset === "tomorrow" ? 1 : (8 - now.getDay()) % 7 || 7;
  wake.setDate(wake.getDate() + days);
  return wake;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How a wake time names its day: nothing today, the weekday within a week, else the date. */
export function snoozeWakeDay(wake: Date, now: Date): Intl.DateTimeFormatOptions | null {
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  // Calendar days, so a daylight-saving change doesn't move a wake across the cutoff.
  const days = Math.round((startOfDay(wake).getTime() - startOfDay(now).getTime()) / DAY_MS);
  if (days === 0) return null;
  return days < 7 ? { weekday: "short" } : { month: "short", day: "numeric" };
}

type SnoozeChange = {
  /** Saves the choice; a rejection rolls it back if no newer choice followed. */
  send: (until: string | null) => Promise<unknown>;
  /** Shows a wake time in the list at once. */
  apply: (until: string | null) => void;
  /** After this chat's newest choice settles: reload the list, and say so if it failed. */
  settled: (failed: { error: unknown } | null) => void;
};

/**
 * Snooze changes for each chat, sent one at a time in the order chosen. Only the newest choice
 * rolls back or reloads, and a rollback restores what the server last saved, so a quick undo
 * can't be covered by an earlier answer.
 */
export function createSnoozeQueue() {
  const inOrder = createChatQueues();
  const latest = new Map<string, string | null>();
  const saved = new Map<string, string | null>();
  const pending = new Map<string, number>();
  return (key: string, until: string | null, current: string | null, change: SnoozeChange) => {
    const waiting = pending.get(key) ?? 0;
    if (waiting === 0) saved.set(key, current);
    pending.set(key, waiting + 1);
    latest.set(key, until);
    change.apply(until);
    void inOrder(key, () => change.send(until))
      .then(
        () => {
          saved.set(key, until);
          return null;
        },
        (error: unknown) => ({ error }),
      )
      .then((failed) => {
        pending.set(key, (pending.get(key) ?? 1) - 1);
        if (latest.get(key) !== until) return;
        if (failed) change.apply(saved.get(key) ?? null);
        change.settled(failed);
      });
  };
}
