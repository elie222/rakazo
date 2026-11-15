import { ph, t } from "@lingui/core/macro";
import type { Routine } from "@rakazo/contracts";
import { formatCron } from "@rakazo/core";
import { cronLabels } from "./cron";

/** Triggers set up on web. Mobile lists them and can remove them, but not add or edit them. */
export type RoutineWebTrigger = "webhookEnabled" | "githubEnabled" | "messageProvider" | "watch";

/** The routine's web-only triggers with their names, in the order the routine lists them. */
export function routineWebTriggers(
  routine: Pick<Routine, RoutineWebTrigger>,
): Array<{ key: RoutineWebTrigger; label: string }> {
  const message =
    routine.messageProvider === "slack"
      ? t`Slack message`
      : routine.messageProvider === "teams"
        ? t`Teams message`
        : t`Message event`;
  return [
    ...(routine.webhookEnabled ? [{ key: "webhookEnabled" as const, label: t`Webhook` }] : []),
    ...(routine.githubEnabled ? [{ key: "githubEnabled" as const, label: t`Git event` }] : []),
    ...(routine.messageProvider ? [{ key: "messageProvider" as const, label: message }] : []),
    ...(routine.watch ? [{ key: "watch" as const, label: t`When something changes` }] : []),
  ];
}

/** The triggers that aren't schedules, by name. */
export function routineTriggerNames(routine: Routine): string[] {
  const web = routineWebTriggers(routine);
  const named = (keys: RoutineWebTrigger[]) =>
    web.filter((trigger) => keys.includes(trigger.key)).map((trigger) => trigger.label);
  return [
    ...named(["webhookEnabled", "githubEnabled", "messageProvider"]),
    ...(routine.emailSenders ? [t`When an email arrives`] : []),
    ...named(["watch"]),
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
    routine.active ? (routine.scheduleDelayed ? t`Schedule delayed` : "") : t`Paused`,
  ]
    .filter(Boolean)
    .join(", ");
}

/** A list row's name for screen readers, with whether its switch is on. */
export function routineRowLabel(routine: Routine): string {
  return routine.active
    ? t`${ph({ name: routine.name })}, On`
    : t`${ph({ name: routine.name })}, Off`;
}

/** The device's IANA time zone, or undefined when the runtime can't tell. */
export function deviceTimeZone(): string | undefined {
  try {
    return globalThis.Intl?.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
