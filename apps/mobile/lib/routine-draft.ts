import type { Routine, RpcInput } from "@rakazo/contracts";
import type { RoutineDraft } from "@rakazo/core";
import { cronFromPreset, draftFromRoutine, isOneShotRoutineCrons } from "@rakazo/core";
import type { RoutineWebTrigger } from "./routine";
import { routineTriggerNames } from "./routine";

/**
 * The editor's draft. A web-only trigger is left out until the person removes it here, so a
 * draft only ever turns one off.
 */
export type MobileRoutineDraft = RoutineDraft & Partial<Pick<Routine, RoutineWebTrigger>>;

/** The routine as this draft would leave it, for the triggers mobile can only remove. */
export function routineWithDraftTriggers(routine: Routine, draft: MobileRoutineDraft): Routine {
  return {
    ...routine,
    ...(draft.webhookEnabled === false ? { webhookEnabled: false } : {}),
    ...(draft.githubEnabled === false ? { githubEnabled: false } : {}),
    ...(draft.messageProvider === null ? { messageProvider: null } : {}),
    ...(draft.watch === null ? { watch: null } : {}),
  };
}

/** A one-shot is set up from chat with its run time; its schedule can't change here. */
export function routineScheduleLocked(routine: Routine | null): boolean {
  return Boolean(routine && isOneShotRoutineCrons(routine.crons));
}

function sameCrons(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((cron, index) => cron === b[index]);
}

/**
 * What an update would change, compared as the editor writes it. Web-only triggers are sent
 * only when removed here, and the routine's own model never is, so the server keeps them.
 */
function routineChanges(draft: MobileRoutineDraft, routine: Routine) {
  const crons = draft.schedules.map(cronFromPreset);
  // A schedule merely opened is not a change, even when the editor would spell it differently.
  const savedCrons = draftFromRoutine(routine).schedules.map(cronFromPreset);
  return {
    ...(draft.name !== routine.name ? { name: draft.name.trim() } : {}),
    ...(draft.prompt !== routine.prompt ? { prompt: draft.prompt.trim() } : {}),
    ...(!routineScheduleLocked(routine) && !sameCrons(crons, savedCrons) ? { crons } : {}),
    ...(draft.emailSenders !== routine.emailSenders ? { emailSenders: draft.emailSenders } : {}),
    ...(draft.active !== routine.active ? { active: draft.active } : {}),
    ...(draft.silent !== (routine.silent ?? false) ? { silent: draft.silent } : {}),
    ...(draft.webhookEnabled === false && routine.webhookEnabled ? { webhookEnabled: false } : {}),
    ...(draft.githubEnabled === false && routine.githubEnabled ? { githubEnabled: false } : {}),
    ...(draft.messageProvider === null && routine.messageProvider ? { messageProvider: null } : {}),
    ...(draft.watch === null && routine.watch ? { watch: null } : {}),
  };
}

/** Whether there is anything to save: a change to the routine, or anything in a new one. */
export function routineDraftChanged(draft: MobileRoutineDraft, routine: Routine | null): boolean {
  if (!routine) {
    return Boolean(
      draft.name.trim() || draft.prompt.trim() || draft.schedules.length || draft.emailSenders,
    );
  }
  return Object.keys(routineChanges(draft, routine)).length > 0;
}

export type RoutineSaveRequest =
  | { error: "name" | "prompt" | "trigger" }
  | { create: RpcInput<"routines/create"> }
  | { update: RpcInput<"routines/update"> }
  | { unchanged: true };

/**
 * The create or update call for a draft. An update sends only what the draft changed, so a
 * stale draft never undoes a pause or edit made elsewhere since it opened.
 */
export function routineSaveRequest(
  draft: MobileRoutineDraft,
  routine: Routine | null,
  botId: string,
  timezone: string,
): RoutineSaveRequest {
  const name = draft.name.trim();
  const prompt = draft.prompt.trim();
  if (!name) return { error: "name" };
  if (!prompt) return { error: "prompt" };
  const crons = draft.schedules.map(cronFromPreset);
  // Triggers this editor doesn't show still count; the email one counts as the draft has it.
  const otherTriggers = routine
    ? routineTriggerNames({ ...routineWithDraftTriggers(routine, draft), emailSenders: null })
        .length > 0
    : false;
  if (!crons.length && !draft.emailSenders && !otherTriggers) return { error: "trigger" };
  if (!routine) {
    return {
      create: {
        botId,
        name,
        prompt,
        crons,
        timezone,
        active: draft.active,
        notify: true,
        ...(draft.silent ? { silent: true } : {}),
        ...(draft.emailSenders ? { emailSenders: draft.emailSenders } : {}),
      },
    };
  }
  const update = routineChanges(draft, routine);
  if (!Object.keys(update).length) return { unchanged: true };
  return { update: { routineId: routine.id, ...update } };
}
