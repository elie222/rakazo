import type { Routine } from "@rakazo/contracts";
import { formatCron } from "@rakazo/core";
import { cronLabels } from "./cron";
import { t } from "./i18n";

/** The triggers that aren't schedules, by name. */
export function routineTriggerNames(routine: Routine): string[] {
  return [
    ...(routine.webhookEnabled ? [t("Webhook")] : []),
    ...(routine.githubEnabled ? [t("Git event")] : []),
    ...(routine.messageProvider === "slack"
      ? [t("Slack message")]
      : routine.messageProvider === "teams"
        ? [t("Teams message")]
        : routine.messageProvider
          ? [t("Message event")]
          : []),
    ...(routine.emailSenders ? [t("When an email arrives")] : []),
    ...(routine.watch ? [t("When something changes")] : []),
  ];
}

function routineTriggers(routine: Routine): string {
  const labels = cronLabels();
  return [
    ...routine.crons.map((cron) => formatCron(cron, labels)),
    ...routineTriggerNames(routine),
  ].join(", ");
}

/** Triggers with their zone in parentheses, or whichever of the two exists. */
function routineSchedule(routine: Routine, zone: string | undefined): string {
  const triggers = routineTriggers(routine);
  return triggers && zone ? `${triggers} (${zone})` : triggers || zone || "";
}

/** One line per trigger for a routine's detail; schedules name their zone when it isn't the device's. */
export function routineTriggerRows(routine: Routine, deviceTimeZone: string | undefined): string[] {
  const labels = cronLabels();
  const zone = routine.timezone === deviceTimeZone ? "" : ` (${routine.timezone})`;
  return [
    ...routine.crons.map((cron) => `${formatCron(cron, labels)}${zone}`),
    ...routineTriggerNames(routine),
  ];
}

/** A list row: the schedule, its zone only when it isn't the device's, and "Paused" only when paused. */
export function routineRowDetail(routine: Routine, deviceTimeZone: string | undefined): string {
  return [
    routineSchedule(routine, routine.timezone === deviceTimeZone ? undefined : routine.timezone),
    routine.active ? (routine.scheduleDelayed ? t("Schedule delayed") : "") : t("Paused"),
  ]
    .filter(Boolean)
    .join(", ");
}

/** A list row's name for screen readers, with whether its switch is on. */
export function routineRowLabel(routine: Routine): string {
  return routine.active
    ? t("{name}, On", { name: routine.name })
    : t("{name}, Off", { name: routine.name });
}

/** The device's IANA time zone, or undefined when the runtime can't tell. */
export function deviceTimeZone(): string | undefined {
  try {
    return globalThis.Intl?.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
