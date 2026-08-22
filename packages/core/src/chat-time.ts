const DAY_MS = 86_400_000;
const TIMESTAMP_GAP_MS = 10 * 60 * 1000;

export function formatClock(date: Date): string {
  const hours24 = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const period = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 || 12;
  return `${hours12}:${minutes} ${period}`;
}

export function formatChatTimestamp(iso: string, now = new Date()): string {
  const date = parseIso(iso);
  if (!date) return "";
  const clock = formatClock(date);
  const dayDiff = calendarDayDiff(date, now);
  if (dayDiff <= 0) return `Today ${clock}`;
  if (dayDiff === 1) return `Yesterday ${clock}`;
  if (dayDiff < 7) {
    return `${weekday(date)} ${clock}`;
  }
  return `${shortDate(date)}, ${clock}`;
}

export function formatInboxTime(iso: string, now = new Date()): string {
  const date = parseIso(iso);
  if (!date) return "";
  const dayDiff = calendarDayDiff(date, now);
  if (dayDiff <= 0) return formatClock(date);
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff < 7) return weekday(date);
  return shortDate(date);
}

export function shouldShowChatTimestamp(previousIso: string | undefined, iso: string): boolean {
  const next = parseIso(iso);
  if (!next) return false;
  if (!previousIso) return true;
  const previous = parseIso(previousIso);
  if (!previous) return true;
  if (next.getTime() - previous.getTime() >= TIMESTAMP_GAP_MS) return true;
  return calendarDayDiff(previous, next) !== 0;
}

function parseIso(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function calendarDayDiff(then: Date, now: Date): number {
  const startOfThen = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  const startOfNow = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((startOfNow - startOfThen) / DAY_MS);
}

function weekday(date: Date): string {
  return date.toLocaleDateString("en-US", { weekday: "long" });
}

function shortDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
