import type { Routine } from "@rakazo/contracts";
import type { CronPreset } from "./cron.js";
import { presetFromCron } from "./cron.js";

/** The fields every routine editor changes; an editor that offers more triggers adds its own. */
export type RoutineDraft = {
  name: string;
  prompt: string;
  schedules: CronPreset[];
  active: boolean;
};

export function emptyRoutineDraft(): RoutineDraft {
  return { name: "", prompt: "", schedules: [], active: true };
}

export function draftFromRoutine(
  routine: Pick<Routine, "name" | "prompt" | "crons" | "active">,
): RoutineDraft {
  return {
    name: routine.name,
    prompt: routine.prompt,
    schedules: routine.crons.map(presetFromCron),
    active: routine.active,
  };
}
