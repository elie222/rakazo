import {
  ACTIVE_RUN_STATUSES,
  isOneShotRoutineCrons,
  routineRepeats,
  wallClock,
  zonedDateTime,
  zonedEndDateTime,
} from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { postRoutineNotice } from "./routine-notice.js";

type RoutineTiming = { crons: string[]; watch: unknown };

const repeats = (routine: RoutineTiming) => routineRepeats(routine.crons, routine.watch != null);

export function runBeforeEnd(next: Date | null, endsAt: Date | null): Date | null {
  return next && endsAt && next.getTime() > endsAt.getTime() ? null : next;
}

export function routineEnded(
  routine: RoutineTiming & { endsAt: Date | null; active: boolean; nextRunAt: Date | null },
): boolean {
  return (
    routine.endsAt !== null && routine.active && routine.nextRunAt === null && repeats(routine)
  );
}

export function routineEndError(
  routine: RoutineTiming & { endsAt: Date | null; nextRunAt: Date | null; events: boolean },
  changed: { end: boolean; nextRun: boolean },
  now = new Date(),
): string | null {
  const { endsAt, nextRunAt } = routine;
  if (!endsAt) return null;
  if (isOneShotRoutineCrons(routine.crons)) return "A one-time routine ends once it runs.";
  if (!repeats(routine)) return "Only a repeating schedule or a watch can have an end date.";
  if (routine.events) {
    return "A routine with webhook, Git, chat or email triggers can't have an end date.";
  }
  if (changed.end && endsAt.getTime() <= now.getTime())
    return "The end date must be in the future.";
  if ((changed.end || changed.nextRun) && nextRunAt && nextRunAt.getTime() > endsAt.getTime()) {
    return "The end date is before the next run.";
  }
  return null;
}

export function routineEndInZone(endsAt: Date | null, from: string, to: string): Date | null {
  if (!endsAt || from === to) return endsAt;
  const moved = zonedDateTime(wallClock(endsAt, from), to);
  return moved ? new Date(moved.getTime() + endsAt.getUTCMilliseconds()) : endsAt;
}

export function routineEndFromText(
  value: string | undefined,
  timezone: string,
): { endsAt: Date | null | undefined } | { error: string } {
  if (value === undefined) return { endsAt: undefined };
  if (value.trim().toLowerCase() === "none") return { endsAt: null };
  const endsAt = zonedEndDateTime(value, timezone);
  return endsAt
    ? { endsAt }
    : { error: 'endAt must be an ISO date or datetime, or "none" to remove the end.' };
}

export function newRoutineEnd(
  value: string | undefined,
  timezone: string,
  timing: RoutineTiming & { nextRunAt: Date | null; events: boolean },
): { endsAt: Date | null } | { error: string } {
  const end = routineEndFromText(value, timezone);
  if ("error" in end) return end;
  const endsAt = end.endsAt ?? null;
  const error = routineEndError({ ...timing, endsAt }, { end: true, nextRun: true });
  return error ? { error } : { endsAt };
}

type SpentRoutineDeps = {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "notify" | "publishSpaceChange">;
};

type EndedRoutine = { spaceId: string; botId: string; threadId: string | null; name: string };

async function announceEnded(deps: SpentRoutineDeps, routine: EndedRoutine) {
  await bestEffort(
    "publish an ended routine",
    deps.events.publishSpaceChange?.(routine.spaceId, "routines"),
  );
  await postRoutineNotice(deps, {
    spaceId: routine.spaceId,
    threadId: routine.threadId,
    botId: routine.botId,
    change: "ended",
    name: routine.name,
  });
}

export async function deleteSpentRoutine(
  deps: SpentRoutineDeps,
  input: { spaceId: string; routineId: string; userId: string },
  options: { oneShots: boolean } = { oneShots: true },
): Promise<boolean> {
  return (
    (await bestEffort("delete a spent routine", deleteIfSpent(deps, input, options.oneShots))) ??
    false
  );
}

async function deleteIfSpent(
  deps: SpentRoutineDeps,
  input: { spaceId: string; routineId: string; userId: string },
  oneShots: boolean,
): Promise<boolean> {
  const routine = await deps.prisma.routine.findUnique({ where: { id: input.routineId } });
  if (!routine || routine.userId !== input.userId || routine.nextRunAt) return false;
  const oneShot =
    oneShots &&
    !routine.active &&
    isOneShotRoutineCrons(routine.crons) &&
    routine.lastRunAt !== null &&
    !routine.webhookEnabled &&
    !routine.githubEnabled &&
    !routine.messageProvider &&
    !routine.emailSenders;
  const ended = routineEnded(routine);
  if (!oneShot && !ended) return false;
  const deleted = await deps.prisma.routine.deleteMany({
    where: {
      id: input.routineId,
      userId: input.userId,
      active: routine.active,
      nextRunAt: null,
      crons: { equals: routine.crons },
      endsAt: routine.endsAt,
      ...(oneShot
        ? {
            lastRunAt: { not: null },
            webhookEnabled: false,
            githubEnabled: false,
            messageProvider: null,
            emailSenders: null,
          }
        : {}),
      runs: { none: { status: { in: [...ACTIVE_RUN_STATUSES] } } },
    },
  });
  if (!deleted.count) return false;
  if (ended) await announceEnded(deps, { ...routine, spaceId: input.spaceId });
  else {
    await bestEffort(
      "publish a deleted routine",
      deps.events.publishSpaceChange?.(input.spaceId, "routines"),
    );
  }
  return true;
}

export async function endRoutinePastItsEnd(
  deps: SpentRoutineDeps,
  routine: EndedRoutine & { id: string; userId: string; endsAt: Date | null },
  scheduledAt: Date,
): Promise<boolean> {
  const due = {
    id: routine.id,
    userId: routine.userId,
    active: true,
    nextRunAt: scheduledAt,
    endsAt: routine.endsAt,
  };
  const deleted = await deps.prisma.routine.deleteMany({
    where: { ...due, runs: { none: { status: { in: [...ACTIVE_RUN_STATUSES] } } } },
  });
  if (deleted.count) {
    await announceEnded(deps, routine);
    return true;
  }
  const stopped = await deps.prisma.routine.updateMany({
    where: due,
    data: { nextRunAt: null },
  });
  if (stopped.count) {
    await bestEffort(
      "publish an ended routine",
      deps.events.publishSpaceChange?.(routine.spaceId, "routines"),
    );
  }
  return stopped.count > 0;
}

/** Ends a watch whose next check falls after its end, instead of claiming that check. */
export async function endWatchPastItsEnd(
  deps: SpentRoutineDeps,
  routine: Omit<EndedRoutine, "threadId"> & {
    id: string;
    userId: string;
    threadId?: string | null;
    endsAt?: Date | null;
  },
  nextRunAt: Date | null,
  scheduledAt: Date,
): Promise<boolean> {
  const { endsAt } = routine;
  if (!endsAt || runBeforeEnd(nextRunAt, endsAt)) return false;
  return endRoutinePastItsEnd(
    deps,
    { ...routine, threadId: routine.threadId ?? null, endsAt },
    scheduledAt,
  );
}

export async function deleteEndedRoutine(
  deps: SpentRoutineDeps,
  run: { spaceId: string; routineId: string | null; userId: string },
): Promise<void> {
  if (!run.routineId) return;
  await deleteSpentRoutine(
    deps,
    { spaceId: run.spaceId, routineId: run.routineId, userId: run.userId },
    { oneShots: false },
  );
}

const STRANDED_AFTER_MS = 60 * 60_000;

export async function deleteStrandedEndedRoutines(
  deps: SpentRoutineDeps,
  now = new Date(),
): Promise<void> {
  const stranded = await deps.prisma.routine.findMany({
    where: {
      active: true,
      nextRunAt: null,
      endsAt: { not: null },
      runs: {
        none: {
          OR: [
            { status: { in: [...ACTIVE_RUN_STATUSES] } },
            { updatedAt: { gt: new Date(now.getTime() - STRANDED_AFTER_MS) } },
          ],
        },
      },
    },
    select: { id: true, spaceId: true, userId: true },
    take: 50,
  });
  for (const routine of stranded) {
    await deleteEndedRoutine(deps, { ...routine, routineId: routine.id });
  }
}
