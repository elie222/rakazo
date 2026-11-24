import type { Routine, RoutineEmailSenders } from "@rakazo/contracts";
import type { CronPreset } from "./schedule.js";
import { isOneShotRoutineCrons, presetFromCron } from "./schedule.js";

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
};

export function emptyRoutineDraft(): RoutineDraft {
  return { name: "", prompt: "", schedules: [], emailSenders: null, active: true, timezone: null };
}

export function draftFromRoutine(
  routine: Pick<Routine, "name" | "prompt" | "crons" | "emailSenders" | "active" | "timezone">,
): RoutineDraft {
  return {
    name: routine.name,
    prompt: routine.prompt,
    schedules: routine.crons.map(presetFromCron),
    emailSenders: routine.emailSenders,
    active: routine.active,
    timezone: routine.timezone,
  };
}

/**
 * The routine a copy starts from: paused, so it never runs alongside the original. Null for a
 * one-time routine, whose schedule is only set up from chat.
 */
export function routineCopy<T extends Pick<Routine, "crons" | "name" | "active">>(
  routine: T,
  name: string,
): T | null {
  return isOneShotRoutineCrons(routine.crons) ? null : { ...routine, name, active: false };
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
