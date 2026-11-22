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
};

export function emptyRoutineDraft(): RoutineDraft {
  return { name: "", prompt: "", schedules: [], emailSenders: null, active: true };
}

export function draftFromRoutine(
  routine: Pick<Routine, "name" | "prompt" | "crons" | "emailSenders" | "active">,
): RoutineDraft {
  return {
    name: routine.name,
    prompt: routine.prompt,
    schedules: routine.crons.map(presetFromCron),
    emailSenders: routine.emailSenders,
    active: routine.active,
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
