import { formatCron } from "@rakazo/core";
import { routineEventsView } from "../routines/routine-triggers.js";
import { localDateTime } from "../runs/assembly/current-time.prompt.js";
import type { ScheduleUpdatePlan } from "./schedule-tools.js";

/** The stored timing as the bot should report it: in the routine's timezone, with the next run. */
export function describeRoutineTiming(row: {
  crons: string[];
  timezone: string;
  nextRunAt: Date | null;
}) {
  return {
    timezone: row.timezone,
    ...(row.crons.length ? { schedule: row.crons.map((cron) => formatCron(cron)).join("; ") } : {}),
    nextRun: row.nextRunAt
      ? (localDateTime(row.nextRunAt, row.timezone) ?? row.nextRunAt.toISOString())
      : null,
  };
}

type StoredRoutineRow = Parameters<typeof routineEventsView>[0] & {
  name: string;
  prompt: string;
  inChat: boolean;
  active: boolean;
  crons: string[];
  timezone: string;
  nextRunAt: Date | null;
};

export type RoutineView = {
  name: string;
  prompt: string;
  inChat: boolean;
  active: boolean;
  timezone: string;
  schedule?: string;
  nextRun: string | null;
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
    "on",
  ] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changes[key] = { before: before[key] ?? null, after: after[key] ?? null };
    }
  }
  return changes;
}

/** A stored routine row as the change report sees it, events included. */
export function routineViewOf(row: StoredRoutineRow): RoutineView {
  return {
    name: row.name,
    prompt: row.prompt,
    inChat: row.inChat,
    active: row.active,
    ...describeRoutineTiming(row),
    on: routineEventsView(row),
  };
}

/**
 * The after-state a change report shows: the row a plan changes with the plan's values, over
 * the events the change ends with. The handler's result and the approval card both read their
 * before and after through these, so the two can never disagree.
 */
export function routineAfterView(
  existing: StoredRoutineRow,
  plan: ScheduleUpdatePlan,
  on: RoutineView["on"],
): RoutineView {
  return {
    name: plan.name ?? existing.name,
    prompt: plan.prompt ?? existing.prompt,
    inChat: plan.inChat ?? existing.inChat,
    active: plan.active,
    ...describeRoutineTiming({
      crons: plan.crons,
      timezone: plan.timezone,
      nextRunAt: plan.nextRunAt,
    }),
    on,
  };
}

/**
 * The changes as diff lines: a field heading, then the old value's lines removed and the new
 * value's lines added. The approval card shows the same lines the change report describes.
 */
export function routineChangesDiffLines(
  changes: Record<string, { before: unknown; after: unknown }>,
): string[] {
  const text = (value: unknown) => (value == null ? "none" : String(value));
  const lines: string[] = [];
  for (const [field, change] of Object.entries(changes)) {
    lines.push(`${field}:`);
    for (const before of text(change.before).split("\n")) lines.push(`- ${before}`);
    for (const after of text(change.after).split("\n")) lines.push(`+ ${after}`);
  }
  return lines;
}
