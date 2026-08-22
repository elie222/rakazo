import { formatInboxTime } from "@rakazo/core";
import type { MobileBot } from "./api";

export function filterBots(bots: MobileBot[], query: string) {
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
  return formatInboxTime(iso, now);
}
