import type { QuietHours } from "@rakazo/contracts";
import { localizedClock, wallClock } from "./cron.js";

/** Quiet hours turn on at 10 PM and end at 7 AM unless the person picks other hours. */
export const DEFAULT_QUIET_HOURS: QuietHours = { start: 22, end: 7 };

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
  // The hour as routines read it: an unknown zone, or none, is UTC.
  const hour = Number(wallClock(now, timeZone || "UTC").slice(11, 13));
  const { start, end } = quietHours;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** The hours one end can take, labeled for `locale`: every hour but the other end's. */
export function quietHourChoices(
  other: number,
  locale: string,
): Array<{ hour: number; label: string }> {
  return Array.from({ length: 24 }, (_, hour) => hour)
    .filter((hour) => hour !== other)
    .map((hour) => ({ hour, label: localizedClock(`${hour}:00`, locale) }));
}

/**
 * The preferences save for new quiet hours. Turning them on for an account without a timezone
 * keeps the device's in the same save, where the hours were picked; null when neither is known,
 * since the hours would then be read in UTC.
 */
export function quietHoursSave(
  quietHours: QuietHours | null,
  savedTimezone: string | null | undefined,
  deviceTimezone: string | undefined,
): { quietHours: QuietHours | null; timezone?: string } | null {
  if (!quietHours || savedTimezone) return { quietHours };
  return deviceTimezone ? { quietHours, timezone: deviceTimezone } : null;
}
