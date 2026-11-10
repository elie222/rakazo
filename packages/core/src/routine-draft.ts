import type { Routine, RoutineEmailSenders } from "@rakazo/contracts";
import type { CronPreset } from "./cron.js";
import { presetFromCron } from "./cron.js";

/** The fields every routine editor changes; an editor that offers more triggers adds its own. */
export type RoutineDraft = {
  name: string;
  prompt: string;
  schedules: CronPreset[];
  /** Whose mail starts the routine; null without an email trigger. */
  emailSenders: RoutineEmailSenders | null;
  active: boolean;
  /** Runs it starts itself post nothing to the chat. */
  silent: boolean;
};

/**
 * Whether a routine offers the Silent switch: only one that starts its own runs, on a schedule or
 * by watching for a change, since a webhook, Git event, email or message posts its delivery in the
 * chat. A routine already silent keeps the switch so it can be turned off.
 */
export function routineOffersSilent(routine: {
  silent: boolean;
  schedules: readonly unknown[];
  watch: unknown;
}): boolean {
  return routine.silent || routine.schedules.length > 0 || Boolean(routine.watch);
}

export function emptyRoutineDraft(): RoutineDraft {
  return { name: "", prompt: "", schedules: [], emailSenders: null, active: true, silent: false };
}

export function draftFromRoutine(
  routine: Pick<Routine, "name" | "prompt" | "crons" | "emailSenders" | "active" | "silent">,
): RoutineDraft {
  return {
    name: routine.name,
    prompt: routine.prompt,
    schedules: routine.crons.map(presetFromCron),
    emailSenders: routine.emailSenders,
    active: routine.active,
    silent: routine.silent ?? false,
  };
}
