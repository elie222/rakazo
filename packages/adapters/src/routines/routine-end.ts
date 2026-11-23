import { ROUTINE_WATCH_DEFAULT_MINUTES } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, isOneShotRoutineCrons, nextRoutineRunDateAcross } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { postRoutineNotice } from "./routine-notice.js";
import { nextRoutineWatchAt, parseRoutineWatch } from "./routine-watch.js";

type RoutineTiming = {
  crons: string[];
  timezone: string;
  watch: unknown;
  endsAt: Date | null;
  active: boolean;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
};

function nextRunFrom(routine: RoutineTiming, from: Date): Date | null {
  if (routine.watch != null) {
    const watch = parseRoutineWatch(routine.watch);
    return nextRoutineWatchAt(watch ?? { everyMinutes: ROUTINE_WATCH_DEFAULT_MINUTES }, from);
  }
  if (isOneShotRoutineCrons(routine.crons)) return null;
  return nextRoutineRunDateAcross(routine.crons, routine.lastRunAt ?? from, from, routine.timezone);
}

export function runBeforeEnd(next: Date | null, endsAt: Date | null): Date | null {
  return next && endsAt && next.getTime() > endsAt.getTime() ? null : next;
}

export function routineEnded(routine: RoutineTiming, now = new Date()): boolean {
  if (!routine.endsAt) return false;
  const next = routine.active && routine.nextRunAt ? routine.nextRunAt : nextRunFrom(routine, now);
  return runBeforeEnd(next, routine.endsAt) === null;
}

export function routineEndError(
  routine: { endsAt: Date | null; crons: string[]; watch: unknown; nextRunAt: Date | null },
  now = new Date(),
): string | null {
  const { endsAt } = routine;
  if (!endsAt) return null;
  if (isOneShotRoutineCrons(routine.crons)) return "A one-time routine ends once it runs.";
  if (routine.crons.length === 0 && routine.watch == null) {
    return "Only a repeating schedule or a watch can have an end date.";
  }
  if (endsAt.getTime() <= now.getTime()) return "The end date must be in the future.";
  if (routine.nextRunAt && routine.nextRunAt.getTime() > endsAt.getTime()) {
    return "The end date is before the next run.";
  }
  return null;
}

type SpentRoutineDeps = {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "notify" | "publishSpaceChange">;
};

export async function deleteSpentRoutine(
  deps: SpentRoutineDeps,
  input: { spaceId: string; routineId: string; userId: string },
): Promise<boolean> {
  return (await bestEffort("delete a spent routine", deleteIfSpent(deps, input))) ?? false;
}

async function deleteIfSpent(
  deps: SpentRoutineDeps,
  input: { spaceId: string; routineId: string; userId: string },
): Promise<boolean> {
  const routine = await deps.prisma.routine.findUnique({ where: { id: input.routineId } });
  if (!routine || routine.userId !== input.userId || routine.active || routine.nextRunAt) {
    return false;
  }
  const oneShot =
    isOneShotRoutineCrons(routine.crons) &&
    routine.lastRunAt !== null &&
    !routine.webhookEnabled &&
    !routine.githubEnabled &&
    !routine.messageProvider &&
    !routine.emailSenders;
  const ended = !oneShot && routineEnded(routine);
  if (!oneShot && !ended) return false;
  const deleted = await deps.prisma.routine.deleteMany({
    where: {
      id: input.routineId,
      userId: input.userId,
      active: false,
      nextRunAt: null,
      crons: { equals: routine.crons },
      timezone: routine.timezone,
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
  await bestEffort(
    "publish a deleted routine",
    deps.events.publishSpaceChange?.(input.spaceId, "routines"),
  );
  if (ended) {
    await postRoutineNotice(deps, {
      spaceId: input.spaceId,
      threadId: routine.threadId,
      botId: routine.botId,
      change: "ended",
      name: routine.name,
    });
  }
  return true;
}

export async function endRoutinePastItsEnd(
  deps: SpentRoutineDeps,
  routine: { id: string; spaceId: string; userId: string },
  scheduledAt: Date,
): Promise<void> {
  const stopped = await deps.prisma.routine.updateMany({
    where: { id: routine.id, userId: routine.userId, active: true, nextRunAt: scheduledAt },
    data: { active: false, nextRunAt: null },
  });
  if (!stopped.count) return;
  const deleted = await deleteSpentRoutine(deps, {
    spaceId: routine.spaceId,
    routineId: routine.id,
    userId: routine.userId,
  });
  if (!deleted) {
    await bestEffort(
      "publish an ended routine",
      deps.events.publishSpaceChange?.(routine.spaceId, "routines"),
    );
  }
}
