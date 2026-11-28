import type { Routine, RpcInput } from "@rakazo/contracts";
import type { RoutineDraft } from "@rakazo/core";
import {
  cronFromPreset,
  draftFromRoutine,
  isOneShotRoutineCrons,
  routineCanEnd,
  routineComputerUpdate,
  routineDraftEndsAt,
  routineEndUpdate,
  routineEventTriggered,
} from "@rakazo/core";
import type { RoutineWebTrigger } from "./routine";
import { routineWebTriggers } from "./routine";

/**
 * The editor's draft. A web-only trigger is left out until the person changes it here: a draft
 * turns any of them off, and can turn a webhook on.
 */
export type MobileRoutineDraft = RoutineDraft &
  Partial<Pick<Routine, RoutineWebTrigger>> & {
    /** Set once the owner flips "Use my computer"; see Routine.useComputer. */
    useComputer?: boolean;
  };

/** The routine as this draft would leave it, for the triggers mobile can't edit. */
export function routineWithDraftTriggers<R extends Pick<Routine, RoutineWebTrigger>>(
  routine: R,
  draft: MobileRoutineDraft,
): R {
  return {
    ...routine,
    ...(draft.webhookEnabled !== undefined ? { webhookEnabled: draft.webhookEnabled } : {}),
    ...(draft.githubEnabled === false ? { githubEnabled: false } : {}),
    ...(draft.messageProvider === null ? { messageProvider: null } : {}),
    ...(draft.watch === null ? { watch: null } : {}),
  };
}

const NO_WEB_TRIGGERS: Pick<Routine, RoutineWebTrigger> = {
  webhookEnabled: false,
  githubEnabled: false,
  messageProvider: null,
  watch: null,
};

/** The web-only triggers a draft would save: those of the routine it edits or copies, if any. */
export function draftWebTriggers(
  source: Routine | null,
  draft: MobileRoutineDraft,
): Pick<Routine, RoutineWebTrigger> {
  return routineWithDraftTriggers(source ?? NO_WEB_TRIGGERS, draft);
}

/** Whether something outside starts the routine the draft would save. */
export function routineDraftEventTriggered(
  draft: MobileRoutineDraft,
  source: Routine | null,
): boolean {
  return routineEventTriggered({
    ...draftWebTriggers(source, draft),
    emailSenders: draft.emailSenders,
  });
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
 * only when changed here, and the routine's own model never is, so the server keeps them.
 */
function routineChanges(draft: MobileRoutineDraft, routine: Routine) {
  const crons = draft.schedules.map(cronFromPreset);
  // A schedule merely opened is not a change, even when the editor would spell it differently.
  const savedCrons = draftFromRoutine(routine).schedules.map(cronFromPreset);
  const name = draft.name !== routine.name ? draft.name.trim() : undefined;
  const prompt = draft.prompt !== routine.prompt ? draft.prompt.trim() : undefined;
  return {
    ...(name !== undefined ? { name } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(!routineScheduleLocked(routine) && !sameCrons(crons, savedCrons) ? { crons } : {}),
    ...(draft.emailSenders !== routine.emailSenders ? { emailSenders: draft.emailSenders } : {}),
    ...(draft.active !== routine.active ? { active: draft.active } : {}),
    ...(draft.webhookEnabled !== undefined && draft.webhookEnabled !== routine.webhookEnabled
      ? { webhookEnabled: draft.webhookEnabled }
      : {}),
    ...(draft.githubEnabled === false && routine.githubEnabled ? { githubEnabled: false } : {}),
    ...(draft.messageProvider === null && routine.messageProvider ? { messageProvider: null } : {}),
    ...(draft.watch === null && routine.watch ? { watch: null } : {}),
    ...routineEndUpdate(
      routine,
      draft.endsOn,
      routineCanEnd(
        routineScheduleLocked(routine) ? routine.crons : crons,
        draft.watch !== null && routine.watch !== null,
        routineDraftEventTriggered(draft, routine),
      ),
    ),
    ...routineComputerUpdate(routine, {
      useComputer: draft.useComputer,
      name: name ?? routine.name,
      prompt: prompt ?? routine.prompt,
      eventTriggered: routineDraftEventTriggered(draft, routine),
    }),
  };
}

/** Whether there is anything to save: a change to the routine, or anything in a new one. */
export function routineDraftChanged(draft: MobileRoutineDraft, routine: Routine | null): boolean {
  if (!routine) {
    return Boolean(
      draft.name.trim() ||
        draft.prompt.trim() ||
        draft.schedules.length ||
        draft.emailSenders ||
        draft.webhookEnabled,
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
  /** The device's zone, for a new routine that isn't a copy. */
  timezone: string,
  /**
   * For a new routine started as a copy: the triggers and settings it keeps from it. Not its model,
   * which this editor can't change and the copier may not have connected.
   */
  copyOf: Routine | null = null,
): RoutineSaveRequest {
  const name = draft.name.trim();
  const prompt = draft.prompt.trim();
  if (!name) return { error: "name" };
  if (!prompt) return { error: "prompt" };
  const crons = draft.schedules.map(cronFromPreset);
  // Triggers this editor doesn't show still count; the email one counts as the draft has it.
  const source = routine ?? copyOf;
  const kept = source ? routineWithDraftTriggers(source, draft) : null;
  const otherTriggers = routineWebTriggers(draftWebTriggers(source, draft)).length > 0;
  if (!crons.length && !draft.emailSenders && !otherTriggers) return { error: "trigger" };
  if (!routine) {
    const zone = draft.timezone ?? timezone;
    const endsAt = routineDraftEndsAt(
      draft.endsOn,
      routineCanEnd(crons, Boolean(kept?.watch), routineDraftEventTriggered(draft, copyOf)),
      zone,
    );
    return {
      create: {
        botId,
        name,
        prompt,
        crons,
        timezone: zone,
        active: draft.active,
        ...(endsAt ? { endsAt } : {}),
        notify: kept?.notify ?? true,
        ...(draft.emailSenders ? { emailSenders: draft.emailSenders } : {}),
        ...(kept
          ? {
              webhookEnabled: kept.webhookEnabled,
              githubEnabled: kept.githubEnabled,
              messageProvider: kept.messageProvider,
              watch: kept.watch,
              inChat: kept.inChat,
            }
          : draft.webhookEnabled
            ? { webhookEnabled: true }
            : {}),
      },
    };
  }
  const update = routineChanges(draft, routine);
  if (!Object.keys(update).length) return { unchanged: true };
  return { update: { routineId: routine.id, ...update } };
}
