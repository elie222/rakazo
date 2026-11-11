import type { QuietHours } from "@rakazo/contracts";

/** Quiet hours turn on at 10 PM and end at 7 AM unless the person picks other hours. */
export const DEFAULT_QUIET_HOURS: QuietHours = { start: 22, end: 7 };

/** The hour of the day, 0 to 23, at `now` in `timeZone`; in UTC when the zone is unknown. */
function hourIn(now: Date, timeZone: string): number {
  try {
    const hour = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .find((part) => part.type === "hour")?.value;
    // Some engines write midnight as 24 even in a 0-23 cycle.
    if (hour !== undefined) return Number(hour) % 24;
  } catch {
    // An unknown zone reads as UTC, like a person with none saved.
  }
  return now.getUTCHours();
}

/**
 * Whether `now` falls in the person's quiet hours, read in their timezone, or UTC while they
 * have none. The start hour is quiet and the end hour is not, so 22 to 7 is quiet from 10 PM
 * until 7 AM.
 */
export function inQuietHours(
  quietHours: QuietHours | null | undefined,
  timeZone: string | null | undefined,
  now: Date,
): boolean {
  if (!quietHours || quietHours.start === quietHours.end) return false;
  const hour = hourIn(now, timeZone || "UTC");
  const { start, end } = quietHours;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
