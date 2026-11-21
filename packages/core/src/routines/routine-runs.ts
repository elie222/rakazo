import type { RoutineHistory, RoutineRun, RoutineRunCursor } from "@rakazo/contracts";
import { ROUTINE_HISTORY_FIRST_PAGE_SIZE, ROUTINE_HISTORY_PAGE_SIZE } from "@rakazo/contracts";

/**
 * Compact human duration, e.g. "850ms", "4.2s", "1m 05s".
 * Returns null when there is no usable duration (missing, non-finite or negative),
 * so the caller can omit the segment entirely.
 */
export function formatCompactDuration(durationMs: number | null | undefined): string | null {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) return null;
  // Pick each bracket from the rounded value, so a value that rounds up to the
  // next unit's boundary (999.5ms, 59.5s) shows in that unit instead.
  const ms = Math.round(durationMs);
  if (ms < 1000) return `${ms}ms`;
  const tenths = Math.round(durationMs / 100);
  if (tenths < 100) {
    const seconds = tenths / 10;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  }
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** When a run is shown as having happened: when it started, else when it was queued. */
export function routineRunAt(run: RoutineRun): string {
  return run.startedAt ?? run.createdAt;
}

/** How late a scheduled run started, in its largest whole unit; null when it started on time. */
export function routineRunLateness(
  run: RoutineRun,
): { unit: "minutes" | "hours" | "days"; count: number } | null {
  if (!run.lateSince || !run.startedAt) return null;
  const minutes = Math.floor((Date.parse(run.startedAt) - Date.parse(run.lateSince)) / 60_000);
  if (minutes < 60) return { unit: "minutes", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hours", count: hours };
  return { unit: "days", count: Math.floor(hours / 24) };
}

/** When a run happened, e.g. "Oct 25, 9:00 AM"; the year only shows outside the current one. */
export function formatRoutineRunAt(run: RoutineRun, locale: string, now = new Date()): string {
  const at = new Date(routineRunAt(run));
  return at.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The history request for one page: a short first page, then fuller older pages. */
export function routineHistoryPage(routineId: string, before: RoutineRunCursor | null) {
  return before
    ? { routineId, before, limit: ROUTINE_HISTORY_PAGE_SIZE }
    : { routineId, limit: ROUTINE_HISTORY_FIRST_PAGE_SIZE };
}

/** History pages, newest first, as one list; a run that shifted onto a later page shows once. */
export function mergeRoutineRunPages(pages: readonly RoutineHistory[]): RoutineRun[] {
  const seen = new Set<string>();
  return pages.flatMap((page) =>
    page.runs.filter((run) => {
      if (seen.has(run.id)) return false;
      seen.add(run.id);
      return true;
    }),
  );
}
