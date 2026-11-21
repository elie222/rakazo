import type { JobPublisher } from "@rakazo/adapter-kit";
import { routineWakeupJob } from "@rakazo/adapter-kit";
import { firstWatchCheck } from "@rakazo/adapters";
import { isOneShotRoutineCrons, nextCronDateAcross } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";

interface ResumeDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events?: Pick<ThreadEvents, "publishSpaceChange">;
}

/**
 * Turns back on the routines that archiving these bots turned off, each on its next occurrence
 * from now. A one-time routine stays off: archiving dropped the time it was set for. Safe to
 * repeat, so a restore that failed part-way is finished by restoring again. Only the restoring
 * member's own routines resume: a routine runs with its owner's accounts, so another member's
 * stays off until they turn it on.
 */
export async function resumeRoutinesAfterRestore(
  deps: ResumeDeps,
  userId: string,
  botIds: string[],
) {
  if (botIds.length === 0) return;
  // Only while it is still marked and its bot is still restored.
  const marked = {
    botId: { in: botIds },
    userId,
    resumeOnRestore: true,
    bot: { archivedAt: null },
  };
  const routines = await deps.prisma.routine.findMany({
    where: marked,
    select: { id: true, spaceId: true },
  });
  for (const { id } of routines) {
    // Under the row lock, so the schedule is computed from the routine as it stands, and with
    // its wakeup in the same transaction, so a routine is never on without one.
    await deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM routines WHERE id = ${id} FOR UPDATE`;
      const routine = await tx.routine.findFirst({
        where: { ...marked, id },
        select: { active: true, crons: true, timezone: true, watch: true },
      });
      if (!routine) return;
      if (routine.active || isOneShotRoutineCrons(routine.crons)) {
        await tx.routine.update({ where: { id }, data: { resumeOnRestore: false } });
        return;
      }
      const nextRunAt =
        routine.watch != null
          ? firstWatchCheck()
          : nextCronDateAcross(routine.crons, new Date(), routine.timezone);
      await tx.routine.update({
        where: { id },
        data: { active: true, nextRunAt, resumeOnRestore: false },
      });
      if (nextRunAt) await deps.jobs.enqueueIn(tx, routineWakeupJob(id, nextRunAt));
    });
  }
  for (const spaceId of new Set(routines.map((routine) => routine.spaceId)))
    await deps.events?.publishSpaceChange?.(spaceId, "routines");
}
