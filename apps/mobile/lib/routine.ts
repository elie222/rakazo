import type { Routine } from "@rakazo/contracts";
import { formatCron } from "@rakazo/core";
import { t } from "./i18n";

function routineTriggers(routine: Routine): string {
  return [
    ...routine.crons.map(formatCron),
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

export function routineStatusLine(routine: Routine): string {
  return [routine.active ? t("Active") : t("Paused"), routineTriggers(routine), routine.timezone]
    .filter(Boolean)
    .join(" · ");
}

/** A list row: the schedule, its zone only when it isn't the device's, and "Paused" only when paused. */
export function routineRowDetail(routine: Routine, deviceTimeZone: string | undefined): string {
  return [
    routineTriggers(routine),
    routine.timezone === deviceTimeZone ? "" : routine.timezone,
    routine.active ? "" : t("Paused"),
  ]
    .filter(Boolean)
    .join(" · ");
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
