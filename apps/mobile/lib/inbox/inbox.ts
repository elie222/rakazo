import { snoozeWakeDay } from "@rakazo/core";
import { dateLocaleForUi } from "../i18n/i18n";

const DAY_MS = 86_400_000;

export function filterBots<T extends { name: string; preview: string }>(
  bots: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return bots;
  return bots.filter((bot) => `${bot.name} ${bot.preview}`.toLowerCase().includes(needle));
}

export function formatThreadTime(iso: string, now = new Date()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfThatDay) / DAY_MS);

  if (dayDiff <= 0) {
    return clockTime(date);
  }
  if (dayDiff < 7) {
    return date.toLocaleDateString(dateLocaleForUi(), { weekday: "long" });
  }
  return date.toLocaleDateString(dateLocaleForUi(), { month: "short", day: "numeric" });
}

/** When a snoozed chat wakes: the time today, the weekday within a week, or the date. */
export function formatSnoozeWake(iso: string, now = new Date()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = clockTime(date);
  const day = snoozeWakeDay(date, now);
  return day ? `${date.toLocaleDateString(dateLocaleForUi(), day)} ${time}` : time;
}

/** The time of day on the phone's 12- or 24-hour clock. */
function clockTime(date: Date) {
  return date.toLocaleTimeString(dateLocaleForUi(), { hour: "numeric", minute: "2-digit" });
}
