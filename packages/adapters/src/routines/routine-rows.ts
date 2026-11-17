import type { JobPublisher } from "@rakazo/adapter-kit";
import { routineWakeupJob } from "@rakazo/adapter-kit";
import type { Actor, CreateRoutineInput } from "@rakazo/contracts";
import {
  ClientError,
  hasMixedOneShotSchedule,
  isOneShotRoutineCrons,
  nextCronDateAcrossStrict,
} from "@rakazo/core";
import type { Prisma, Routine, ThreadEvents } from "@rakazo/db";

/** A routine's row and first run, checked as the routine API and an agent import write it. */

export function assertRoutineSchedule(input: CreateRoutineInput): void {
  if (hasMixedOneShotSchedule(input.crons)) {
    throw new ClientError(
      "BAD_REQUEST",
      "A one-time schedule can't be combined with other schedules.",
    );
  }
  if (input.active && isOneShotRoutineCrons(input.crons)) {
    throw new ClientError("BAD_REQUEST", "One-shot schedules must be created from chat.");
  }
}

export function routineNextRunAt(input: CreateRoutineInput): Date | null {
  // Validate every recurring cron even when inactive; @once and webhook-only have no next date.
  let nextRunAt: Date | null = null;
  if (input.crons.length > 0 && !isOneShotRoutineCrons(input.crons)) {
    const computedNextRunAt = nextRoutineDate(input.crons, input.timezone);
    nextRunAt = input.active ? computedNextRunAt : null;
  }
  // A change trigger takes its first reading right away; that reading is the baseline.
  if (input.watch && input.active) nextRunAt = firstWatchCheck();
  return nextRunAt;
}

export function routineRowData(actor: Actor, input: CreateRoutineInput, nextRunAt: Date | null) {
  return {
    spaceId: actor.spaceId,
    botId: input.botId,
    userId: actor.userId,
    name: input.name,
    prompt: input.prompt,
    crons: input.crons,
    timezone: input.timezone,
    notify: input.notify,
    active: input.active,
    webhookEnabled: input.webhookEnabled,
    githubEnabled: input.githubEnabled,
    messageProvider: input.messageProvider,
    emailSenders: input.emailSenders,
    modelProvider: input.modelProvider,
    modelId: input.modelId,
    thinkingLevel: input.thinkingLevel,
    ...(input.watch ? { watch: input.watch as Prisma.InputJsonValue } : {}),
    nextRunAt,
  };
}

export function nextRoutineDate(crons: string[], timezone: string): Date {
  let next: Date | null;
  try {
    next = nextCronDateAcrossStrict(crons, new Date(), timezone);
  } catch {
    // Parsing the caller's expressions is all this does, so any failure is a malformed one.
    throw new ClientError("BAD_REQUEST", "Enter a valid cron expression.");
  }
  if (!next) throw new ClientError("BAD_REQUEST", "Enter a valid cron expression.");
  return next;
}

/** A new or re-armed watch takes its first reading a moment from now. */
export function firstWatchCheck(): Date {
  return new Date(Date.now() + 2_000);
}

/** Tells the bot's thread a routine was added, and wakes it when it is on. */
export async function announceRoutineRow(
  deps: { events: Pick<ThreadEvents, "append">; jobs: Pick<JobPublisher, "enqueue"> },
  actor: Pick<Actor, "spaceId">,
  bot: { id: string; thread: { id: string } | null },
  row: Routine,
): Promise<void> {
  if (bot.thread) {
    await deps.events.append({
      spaceId: actor.spaceId,
      threadId: bot.thread.id,
      botId: bot.id,
      type: "routine.created",
      payload: { name: row.name },
    });
  }
  if (row.active && row.nextRunAt) {
    await deps.jobs.enqueue(routineWakeupJob(row.id, row.nextRunAt));
  }
}
