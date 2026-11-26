import type { Routine, RoutineEmailSenders } from "@rakazo/contracts";
import {
  DAY_MS,
  isEndOfZonedDay,
  wallClock,
  zonedDateTime,
  zonedEndDateTime,
} from "../primitives/time.js";
import type { CronPreset } from "./schedule.js";
import { isOneShotRoutineCrons, nextCronDateAcross, presetFromCron } from "./schedule.js";

/** The fields every routine editor changes; an editor that offers more triggers adds its own. */
export type RoutineDraft = {
  name: string;
  prompt: string;
  schedules: CronPreset[];
  /** Whose mail starts the routine; null without an email trigger. */
  emailSenders: RoutineEmailSenders | null;
  active: boolean;
  /** The zone its schedules run in, kept by a copy; null for a new routine, which takes its creator's. */
  timezone: string | null;
  endsOn: string;
};

export function emptyRoutineDraft(): RoutineDraft {
  return {
    name: "",
    prompt: "",
    schedules: [],
    emailSenders: null,
    active: true,
    timezone: null,
    endsOn: "",
  };
}

function endsOnDay(routine: Pick<Routine, "endsAt" | "timezone">): string {
  return routine.endsAt ? wallClock(new Date(routine.endsAt), routine.timezone).slice(0, 10) : "";
}

export function draftFromRoutine(
  routine: Pick<
    Routine,
    "name" | "prompt" | "crons" | "emailSenders" | "active" | "endsAt" | "timezone"
  >,
): RoutineDraft {
  return {
    name: routine.name,
    prompt: routine.prompt,
    schedules: routine.crons.map(presetFromCron),
    emailSenders: routine.emailSenders,
    active: routine.active,
    timezone: routine.timezone,
    endsOn: endsOnDay(routine),
  };
}

export function routineCanEnd(
  crons: string[],
  watching: boolean,
  eventTriggered: boolean,
): boolean {
  return !eventTriggered && routineRepeats(crons, watching);
}

export function routineRepeats(crons: string[], watching: boolean): boolean {
  return watching || (crons.length > 0 && !isOneShotRoutineCrons(crons));
}

export function routineDraftEndsAt(
  endsOn: string,
  repeats: boolean,
  timezone: string,
): string | null {
  if (!repeats || !endsOn) return null;
  return zonedEndDateTime(endsOn, timezone)?.toISOString() ?? null;
}

export function routineEndUpdate(
  routine: Pick<Routine, "endsAt" | "timezone">,
  endsOn: string,
  repeats: boolean,
): { endsAt?: string | null } {
  const endsAt = routineDraftEndsAt(endsOn, repeats, routine.timezone);
  if (endsAt === null) return routine.endsAt ? { endsAt: null } : {};
  if (endsOn === endsOnDay(routine)) return {};
  const saved = routine.endsAt ? new Date(routine.endsAt) : null;
  if (!saved || isEndOfZonedDay(saved, routine.timezone)) return { endsAt };
  const time = wallClock(saved, routine.timezone).slice(11);
  const moved = zonedDateTime(`${endsOn}T${time}`, routine.timezone);
  return { endsAt: moved?.toISOString() ?? endsAt };
}

export function defaultRoutineEndDay(crons: string[], timezone: string, now = new Date()): string {
  const weekAhead = new Date(now.getTime() + 7 * DAY_MS);
  const next = nextCronDateAcross(crons, now, timezone);
  const later = next && next.getTime() > weekAhead.getTime() ? next : weekAhead;
  return wallClock(later, timezone).slice(0, 10);
}

export function formatRoutineEnd(endsAt: string, timezone: string, locale: string): string {
  const end = new Date(endsAt);
  const now = new Date();
  const sameYear = wallClock(end, timezone).slice(0, 4) === wallClock(now, timezone).slice(0, 4);
  return end.toLocaleString(locale, {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    ...(isEndOfZonedDay(end, timezone) ? {} : { hour: "numeric", minute: "2-digit" }),
  });
}

/**
 * The routine a copy starts from: paused, so it never runs alongside the original. Null for a
 * one-time routine, whose schedule is only set up from chat.
 */
export function routineCopy<
  T extends Pick<Routine, "crons" | "name" | "active"> & { endsAt?: string | null },
>(routine: T, name: string, now = Date.now()): T | null {
  if (isOneShotRoutineCrons(routine.crons)) return null;
  const ended = routine.endsAt != null && Date.parse(routine.endsAt) <= now;
  return { ...routine, name, active: false, ...(ended ? { endsAt: null } : {}) };
}

/**
 * The "Use my computer" part of an editor's update, given the name and prompt it will send. Turning
 * it on approves the prompt shown, and so does saving an edited prompt or name while it shows on,
 * which would otherwise turn it off on the server. Left out when the viewer isn't offered it, when
 * an outside event starts the routine (the server refuses it) or when nothing it covers changed.
 */
export function routineComputerUpdate(
  routine: Pick<Routine, "useComputer" | "name" | "prompt">,
  next: { useComputer: boolean | undefined; name: string; prompt: string; eventTriggered: boolean },
): { useComputer?: boolean; prompt?: string } {
  if (routine.useComputer === undefined) return {};
  const on = next.useComputer ?? routine.useComputer;
  if (on && next.eventTriggered) return {};
  if (on !== routine.useComputer)
    return on ? { useComputer: on, prompt: next.prompt } : { useComputer: on };
  return on && (next.prompt !== routine.prompt || next.name !== routine.name)
    ? { useComputer: true, prompt: next.prompt }
    : {};
}
