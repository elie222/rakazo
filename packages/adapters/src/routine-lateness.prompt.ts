import { localDateTime } from "./current-time.prompt.js";

/** Tells a run that started late when it was due and when it started, in the routine's timezone. */
export function lateRoutineRunInstruction(dueAt: Date, now: Date, timezone: string): string {
  const zone = localDateTime(now, timezone) ? timezone : undefined;
  const format = (date: Date) =>
    zone
      ? `${localDateTime(date, zone)} (${zone})`
      : `${date.toISOString().replace(/\.\d{3}Z$/, "Z")} (UTC)`;
  return [
    `This scheduled run started late: it was due ${format(dueAt)} and started ${format(now)}.`,
    "Adapt anything that depends on the time of day to the actual time, skip steps that no longer make sense, and mention the delay when it matters to the user.",
  ].join(" ");
}
