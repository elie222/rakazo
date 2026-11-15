import fc from "fast-check";

const FIXED_ZONES = [
  "UTC",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Asia/Tokyo",
  "America/Sao_Paulo",
  "Pacific/Kiritimati",
];

// Each zone with one instant its clocks change at: forward and backward, by an hour and by
// half an hour, in the small hours and at local midnight.
const CLOCK_CHANGES = [
  ["America/New_York", "2026-03-08T07:00:00Z"],
  ["America/New_York", "2026-11-01T06:00:00Z"],
  ["America/St_Johns", "2026-03-08T05:30:00Z"],
  ["America/St_Johns", "2026-11-01T04:30:00Z"],
  ["America/Santiago", "2026-04-05T03:00:00Z"],
  ["America/Santiago", "2026-09-06T04:00:00Z"],
  ["America/Havana", "2026-03-08T05:00:00Z"],
  ["America/Havana", "2026-11-01T05:00:00Z"],
  ["Europe/London", "2026-03-29T01:00:00Z"],
  ["Europe/London", "2026-10-25T01:00:00Z"],
  ["Europe/Berlin", "2026-03-29T01:00:00Z"],
  ["Europe/Berlin", "2026-10-25T01:00:00Z"],
  ["Africa/Cairo", "2026-04-23T22:00:00Z"],
  ["Africa/Cairo", "2026-10-29T21:00:00Z"],
  ["Asia/Jerusalem", "2026-03-27T00:00:00Z"],
  ["Asia/Jerusalem", "2026-10-24T23:00:00Z"],
  ["Asia/Beirut", "2026-03-28T22:00:00Z"],
  ["Asia/Beirut", "2026-10-24T21:00:00Z"],
  ["Australia/Lord_Howe", "2026-04-04T15:00:00Z"],
  ["Australia/Lord_Howe", "2026-10-03T15:30:00Z"],
  ["Pacific/Chatham", "2026-04-04T14:00:00Z"],
  ["Pacific/Chatham", "2026-09-26T14:00:00Z"],
] as const;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type ZonedInstant = { timeZone: string; at: Date };

/**
 * A zone and an instant in it: within three days of a clock change, at the wall-clock time of
 * a clock change some days before it, or anywhere in twenty years.
 */
export const zonedInstant: fc.Arbitrary<ZonedInstant> = fc.oneof(
  fc
    .tuple(
      fc.constantFrom(...CLOCK_CHANGES),
      fc.integer({ min: -3 * DAY, max: 3 * DAY }),
      fc.boolean(),
    )
    .map(([[timeZone, change], offset, onTheMinute]) => ({
      timeZone,
      at: new Date(Date.parse(change) + (onTheMinute ? offset - (offset % 60_000) : offset)),
    })),
  fc
    .tuple(fc.constantFrom(...CLOCK_CHANGES), fc.integer({ min: 1, max: 40 }), fc.nat(59))
    .map(([[timeZone, change], days, minutes]) => ({
      timeZone,
      at: new Date(Date.parse(change) - days * DAY + minutes * 60_000),
    })),
  fc
    .tuple(
      fc.constantFrom(...FIXED_ZONES, ...CLOCK_CHANGES.map(([timeZone]) => timeZone)),
      fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2040, 0, 1) }),
    )
    .map(([timeZone, ms]) => ({ timeZone, at: new Date(ms) })),
);

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type LocalTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 is Sunday. */
  weekday: number;
  /** Days since the epoch of the local calendar date. */
  dayNumber: number;
};

/** The wall clock of `at` in `timeZone`, read through Intl instead of the code under test. */
export function localTime(at: Date, timeZone: string): LocalTime {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  const fields: Record<string, string> = {};
  for (const part of formatter.formatToParts(at)) fields[part.type] = part.value;
  const [year, month, day] = [Number(fields.year), Number(fields.month), Number(fields.day)];
  return {
    year,
    month,
    day,
    hour: Number(fields.hour),
    minute: Number(fields.minute),
    second: Number(fields.second),
    weekday: WEEKDAYS.indexOf(fields.weekday ?? ""),
    dayNumber: Date.UTC(year, month - 1, day) / DAY,
  };
}

function utcOffset(at: Date, timeZone: string): number {
  const local = localTime(at, timeZone);
  const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  return wall - Math.floor(at.getTime() / 60_000) * 60_000;
}

/** Whether the zone's clocks change within four hours either side of `at`. */
export function nearClockChange(at: Date, timeZone: string): boolean {
  return (
    utcOffset(new Date(at.getTime() - 4 * HOUR), timeZone) !==
    utcOffset(new Date(at.getTime() + 4 * HOUR), timeZone)
  );
}

/** Whether `at` is in the second pass of a wall-clock span that clocks going back repeat. */
export function inRepeatedSpan(at: Date, timeZone: string): boolean {
  const now = utcOffset(at, timeZone);
  const repeated = utcOffset(new Date(at.getTime() - 4 * HOUR), timeZone) - now;
  return repeated > 0 && utcOffset(new Date(at.getTime() - repeated), timeZone) !== now;
}
