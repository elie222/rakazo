import type { RoutineApprovalChange } from "@rakazo/contracts";
import { RoutineApprovalField } from "@rakazo/contracts";
import { formatCron, redactSecrets, sliceWellFormed } from "@rakazo/core";
import type { routineEventsView } from "../routines/routine-triggers.js";
import { localDateTime } from "../runs/assembly/current-time.prompt.js";

/** The stored timing as the bot should report it: in the routine's timezone, with the next run and end. */
export function describeRoutineTiming(row: {
  crons: string[];
  timezone: string;
  nextRunAt: Date | null;
  endsAt?: Date | null;
}) {
  const local = (at: Date) => localDateTime(at, row.timezone) ?? at.toISOString();
  return {
    timezone: row.timezone,
    ...(row.crons.length ? { schedule: row.crons.map((cron) => formatCron(cron)).join("; ") } : {}),
    nextRun: row.nextRunAt ? local(row.nextRunAt) : null,
    ...(row.endsAt ? { endAt: local(row.endsAt) } : {}),
  };
}

/** How a routine reads in a change report: the fields the schedule tools compare. */
export type RoutineView = {
  name: string;
  prompt: string;
  inChat: boolean;
  active: boolean;
  timezone: string;
  schedule?: string;
  nextRun: string | null;
  endAt?: string;
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
    "endAt",
    "everyMinutes",
    "on",
  ] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changes[key] = { before: before[key] ?? null, after: after[key] ?? null };
    }
  }
  return changes;
}

const CARD_BEFORE_PROMPT_MAX = 800;

export function routineApprovalChanges(
  changes: Record<string, { before: unknown; after: unknown }>,
  secrets: readonly string[],
): RoutineApprovalChange[] {
  const clean = (value: unknown) =>
    typeof value === "string"
      ? redactSecrets(value, secrets)
      : typeof value === "boolean"
        ? value
        : null;
  return RoutineApprovalField.options.flatMap((field) => {
    const change = changes[field];
    if (!change) return [];
    const before = clean(change.before);
    return [
      {
        field,
        // Redact the whole value before clipping it, so a secret crossing the boundary stays hidden.
        before:
          field === "prompt" && typeof before === "string" && before.length > CARD_BEFORE_PROMPT_MAX
            ? `${sliceWellFormed(before, CARD_BEFORE_PROMPT_MAX)}…`
            : before,
        after: clean(change.after),
      },
    ];
  });
}

/** A readable fallback for clients that only render an approval's text detail. */
export function routineApprovalLines(changes: RoutineApprovalChange[]): string[] {
  const labels: Record<RoutineApprovalChange["field"], string> = {
    active: "Status",
    name: "Name",
    schedule: "Schedule",
    timezone: "Time zone",
    nextRun: "Next run",
    inChat: "Where it runs",
    prompt: "Instructions",
  };
  return changes.flatMap(({ field, before, after }) => {
    const text = (value: RoutineApprovalChange["after"]) => {
      // Put continuation lines inside the value, so they cannot look like another approval field.
      if (typeof value === "string") return value.replace(/\r\n|[\r\n\u2028\u2029]/g, "\n    ");
      if (value === null) return "None";
      return field === "inChat"
        ? value
          ? "In this chat"
          : "Separately from this chat"
        : value
          ? "Active"
          : "Paused";
    };
    return [`${labels[field]}: ${text(after)}`, `Previously: ${text(before)}`];
  });
}
