import type { routineEventsView } from "../routines/routine-triggers.js";

/**
 * How a routine edit reads: what a routine holds as its change report compares it, the fields an
 * edit changed with their before and after, and those as the diff lines an approval card shows.
 */

/** How a routine reads in a change report: the fields the schedule tools compare. */
export type RoutineView = {
  name: string;
  prompt: string;
  inChat: boolean;
  active: boolean;
  timezone: string;
  schedule?: string;
  nextRun: string | null;
  everyMinutes?: number;
  on: ReturnType<typeof routineEventsView>;
};

/** Before and after for each field an update changed; a field that kept its value is left out. */
export function routineChanges(before: RoutineView, after: RoutineView) {
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of [
    "name",
    "prompt",
    "inChat",
    "active",
    "timezone",
    "schedule",
    "nextRun",
    "everyMinutes",
    "on",
  ] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changes[key] = { before: before[key] ?? null, after: after[key] ?? null };
    }
  }
  return changes;
}

/**
 * The changes as diff lines: a field's heading, then its old value's lines removed and its new
 * value's lines added. The approval card shows the same change the saved result reports.
 */
export function routineChangesDiffLines(
  changes: Record<string, { before: unknown; after: unknown }>,
): string[] {
  // A structured value, such as a routine's events, reads as it does in the tool's result.
  const text = (value: unknown) =>
    value == null ? "none" : typeof value === "object" ? JSON.stringify(value) : String(value);
  // A prompt goes last, so a long one can only be cut itself, never the short fields after it.
  const last = (field: string) => Number(field === "prompt");
  const fields = Object.entries(changes).sort(([a], [b]) => last(a) - last(b));
  const lines: string[] = [];
  for (const [field, change] of fields) {
    lines.push(`${field}:`);
    for (const before of text(change.before).split("\n")) lines.push(`- ${before}`);
    for (const after of text(change.after).split("\n")) lines.push(`+ ${after}`);
  }
  return lines;
}
