import { dateLocaleForUi } from "./i18n";

const DAY_MS = 86_400_000;

export function filterBots<T extends { name: string; title: string; preview: string }>(
  bots: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return bots;
  return bots.filter((bot) =>
    `${bot.name} ${bot.title} ${bot.preview}`.toLowerCase().includes(needle),
  );
}

export function botTag(title: string, name: string, maxLength = 22) {
  const tag = title.trim();
  if (!tag || tag.toLowerCase() === name.trim().toLowerCase()) return "";
  if (tag.length > maxLength) return "";
  return tag;
}

export function userInitials(name: string) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return initials || "?";
}

export function formatThreadTime(iso: string, now = new Date()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfThatDay) / DAY_MS);

  if (dayDiff <= 0) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  if (dayDiff < 7) {
    return date.toLocaleDateString(dateLocaleForUi(), { weekday: "long" });
  }
  return date.toLocaleDateString(dateLocaleForUi(), { month: "short", day: "numeric" });
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}
