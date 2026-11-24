import { CronDate } from "croner";

/** A localized month and day, with the year when it differs in the viewer's time zone. */
export function formatShortHistoryDate(date: Date, now: Date, locale: string): string {
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

/**
 * An ISO date or datetime as an instant. One with an offset (or Z) is taken as written; a date
 * or wall-clock time without one is read in `timezone`, so "2026-11-02T10:00" is 10:00 there.
 * A time skipped by a daylight-saving change moves forward by the gap. Null when invalid.
 */
export function zonedDateTime(value: string, timezone = "UTC"): Date | null {
  const text = value.trim();
  const wall = ISO_DATE_TIME.exec(text);
  if (!wall) return null;
  const [year, month, day, hour, minute, second] = wall
    .slice(1, 7)
    .map((part) => (part === undefined ? 0 : Number(part)));
  const ms = wall[7] ? Math.floor(Number(`0.${wall[7]}`) * 1000) : 0;
  const check = new Date(0);
  check.setUTCFullYear(year ?? 0, (month ?? 1) - 1, day ?? 1);
  check.setUTCHours(hour ?? 0, minute ?? 0, second ?? 0);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== (month ?? 1) - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return null;
  }
  if (wall[8]) {
    // Date only parses an offset with minutes; ISO 8601 also allows hours alone (+05).
    const instant = new Date(/^[+-]\d{2}$/.test(wall[8]) ? `${text}:00` : text);
    return Number.isFinite(instant.getTime()) ? instant : null;
  }
  const local = new CronDate(new Date(), validTimezoneOrUtc(timezone));
  local.year = check.getUTCFullYear();
  local.month = check.getUTCMonth();
  local.day = check.getUTCDate();
  local.hour = check.getUTCHours();
  local.minute = check.getUTCMinutes();
  local.second = check.getUTCSeconds();
  local.ms = 0;
  // Keep any fraction so a time just after an occurrence does not include it.
  return new Date(local.getDate().getTime() + ms);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function zonedEndDateTime(value: string, timezone = "UTC"): Date | null {
  const text = value.trim();
  return zonedDateTime(ISO_DATE.test(text) ? `${text}T23:59:59.999` : text, timezone);
}

export function isEndOfZonedDay(instant: Date, timezone = "UTC"): boolean {
  return wallClock(instant, timezone).endsWith("T23:59:59");
}

/** The local date and time of `instant` in `timezone`, as zonedDateTime reads it back. */
export function wallClock(instant: Date, timezone = "UTC"): string {
  const local = new CronDate(instant, validTimezoneOrUtc(timezone));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${local.year}-${pad(local.month + 1)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}:${pad(local.second)}`;
}

export const DAY_MS = 86_400_000;

function zoneOffset(instant: number, zone: string): number {
  const local = new CronDate(new Date(instant), zone);
  // CronDate stores months zero-based, like Date.
  const wall = Date.UTC(
    local.year,
    local.month,
    local.day,
    local.hour,
    local.minute,
    local.second,
    local.ms,
  );
  return wall - instant;
}

/** The zone's wall-clock reading of `instant`, as the UTC timestamp that shows the same fields. */
export function wallTime(instant: number, zone: string): number {
  return instant + zoneOffset(instant, zone);
}

/**
 * The instant `zone` shows a wall-clock reading (as wallTime returns it). A reading that clocks
 * going back repeat is its first occurrence; one that clocks going forward skip is the end of
 * the gap, so a schedule in the gap runs once, as soon as the clocks have moved.
 */
export function instantOfWallTime(wall: number, zone: string): number {
  // A day either side is beyond any clock change that could affect this reading.
  const before = wall - zoneOffset(wall - DAY_MS, zone);
  const after = wall - zoneOffset(wall + DAY_MS, zone);
  let earlier = Math.min(before, after);
  let later = Math.max(before, after);
  if (wallTime(earlier, zone) === wall) return earlier;
  if (wallTime(later, zone) === wall) return later;
  const offsetBeforeGap = zoneOffset(earlier, zone);
  while (later - earlier > 1) {
    const middle = Math.floor((earlier + later) / 2);
    if (zoneOffset(middle, zone) === offsetBeforeGap) earlier = middle;
    else later = middle;
  }
  return later;
}

export function validTimezoneOrUtc(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    return "UTC";
  }
}
