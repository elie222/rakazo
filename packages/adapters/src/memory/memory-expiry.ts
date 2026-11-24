import { wallClock } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { userTimeZone } from "../tools/schedule-tools.js";

const STAMP = /\s*\(saved (\d{4}-\d{2}-\d{2})(?:, ends (.+))?\)$/;

/** Today for the run's user; a failed time zone lookup falls back to UTC instead of failing the run. */
export async function userMemoryDate(
  prisma: PrismaClient,
  userId: string,
  now: Date,
): Promise<string> {
  const timeZone = await bestEffort(
    "load the user's time zone for memory dates",
    userTimeZone(prisma, userId),
  );
  return wallClock(now, timeZone ?? "UTC").slice(0, 10);
}

/**
 * The date in the last time zone to reach it. Members of a Space can be a day apart, so an
 * entry ends only once its last day is over for all of them.
 */
export function latestEndedDate(now: Date): string {
  return wallClock(now, "Etc/GMT+12").slice(0, 10);
}

/** One entry with the date it was saved and, for a temporary one, the date or event that ends it. */
export function stampMemoryEntry(content: string, today: string, until = ""): string {
  const end = until
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^until\s+/i, "")
    .replace(/[()]/g, "");
  // An entry that ends is one line, so it leaves memory whole.
  const text = withoutStamp((end ? content.replace(/\s+/g, " ") : content).trim());
  const ends = !end
    ? ""
    : isDate(end)
      ? `, ends ${end}`
      : `, ends when ${end.replace(/^when\s+/i, "")}`;
  return `${text} (saved ${today}${ends})`;
}

export function withoutStamp(entry: string): string {
  return entry.replace(STAMP, "");
}

/** The fact and its end without the saved date, so saving the same entry another day is a repeat. */
export function withoutSavedDate(entry: string): string {
  const stamp = STAMP.exec(entry);
  return stamp ? `${withoutStamp(entry)}${stamp[2] ? ` (ends ${stamp[2]})` : ""}` : entry;
}

function isDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

function endDate(line: string): string | null {
  const end = STAMP.exec(line.trimEnd())?.[2];
  return end && isDate(end) ? end : null;
}

/** Splits memory into entries still in force and those whose end date is before today. */
export function splitEndedEntries(
  content: string,
  today: string,
): { current: string; ended: string[] } {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const ended = lines.filter((line) => (endDate(line) ?? "9999-12-31") < today);
  if (!ended.length) return { current: content, ended };
  return { current: lines.filter((line) => !ended.includes(line)).join("\n"), ended };
}
