import type { Routine } from "@rakazo/contracts";
import { formatCron } from "@rakazo/core";
import { cronLabels } from "./cron";
import { t } from "./i18n";

function routineTriggers(routine: Routine): string {
  const labels = cronLabels();
  return [
    ...routine.crons.map((cron) => formatCron(cron, labels)),
    ...(routine.webhookEnabled ? [t("Webhook")] : []),
    ...(routine.githubEnabled ? [t("Git event")] : []),
    ...(routine.messageProvider === "slack"
      ? [t("Slack message")]
      : routine.messageProvider === "teams"
        ? [t("Teams message")]
        : routine.messageProvider
          ? [t("Message event")]
          : []),
    ...(routine.watch ? [t("When something changes")] : []),
  ].join(", ");
}

/** Triggers with their zone in parentheses, or whichever of the two exists. */
function routineSchedule(routine: Routine, zone: string | undefined): string {
  const triggers = routineTriggers(routine);
  return triggers && zone ? `${triggers} (${zone})` : triggers || zone || "";
}

export function routineStatusLine(routine: Routine): string {
  return [routine.active ? t("Active") : t("Paused"), routineSchedule(routine, routine.timezone)]
    .filter(Boolean)
    .join(", ");
}

/** A list row: the schedule, its zone only when it isn't the device's, and "Paused" only when paused. */
export function routineRowDetail(routine: Routine, deviceTimeZone: string | undefined): string {
  return [
    routineSchedule(routine, routine.timezone === deviceTimeZone ? undefined : routine.timezone),
    routine.active ? "" : t("Paused"),
  ]
    .filter(Boolean)
    .join(", ");
}

/** Soonest next run first, routines without one last; ties keep the oldest first. */
export function sortRoutinesByNextRun(routines: Routine[]): Routine[] {
  const nextRun = (routine: Routine) =>
    routine.nextRunAt ? Date.parse(routine.nextRunAt) : Number.POSITIVE_INFINITY;
  return [...routines].sort(
    (a, b) => nextRun(a) - nextRun(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
}

/** The device's IANA time zone, or undefined when the runtime can't tell. */
export function deviceTimeZone(): string | undefined {
  try {
    return globalThis.Intl?.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
