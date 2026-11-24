import { wallClock } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { userTimeZone } from "../tools/schedule-tools.js";

const STAMP = /\s*\(saved (\d{4}-\d{2}-\d{2})(?:, ends (.+))?\)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The user's calendar date, which saved and end dates are written in. */
function memoryDate(now: Date, timeZone: string | null | undefined): string {
  return wallClock(now, timeZone ?? "UTC").slice(0, 10);
}

/** Today for the run's user; a failed time zone lookup falls back to UTC instead of failing the run. */
export async function userMemoryDate(
  prisma: PrismaClient,
  userId: string,
  now: Date,
): Promise<string> {
  return memoryDate(
    now,
    await bestEffort("load the user's time zone for memory dates", userTimeZone(prisma, userId)),
  );
}

/** One entry with the date it was saved and, for a temporary one, the date or event that ends it. */
export function stampMemoryEntry(content: string, today: string, until = ""): string {
  const text = withoutStamp(content.trim());
  const end = until
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^until\s+/i, "")
    .replace(/[()]/g, "");
  const date = /^\d{4}-\d{2}-\d{2}/.exec(end)?.[0];
  const ends = !end ? "" : date ? `, ends ${date}` : `, ends when ${end.replace(/^when\s+/i, "")}`;
  return `${text} (saved ${today}${ends})`;
}

export function withoutStamp(entry: string): string {
  return entry.replace(STAMP, "");
}

function endDate(line: string): string | null {
  const end = STAMP.exec(line.trimEnd())?.[2];
  return end && ISO_DATE.test(end) ? end : null;
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
