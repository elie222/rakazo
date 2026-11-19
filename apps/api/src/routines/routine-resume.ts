import type { JobPublisher } from "@rakazo/adapter-kit";
import { routineWakeupJob } from "@rakazo/adapter-kit";
import { isOneShotRoutineCrons, nextCronDateAcross } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { firstWatchCheck } from "./routines.js";

interface ResumeDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events?: Pick<ThreadEvents, "publishSpaceChange">;
}

/**
 * Turns back on the routines that archiving these bots turned off, each on its next occurrence
 * from now. A one-time routine stays off: archiving dropped the time it was set for. Safe to
 * repeat, so a restore that failed part-way is finished by restoring again.
 */
export async function resumeRoutinesAfterRestore(deps: ResumeDeps, botIds: string[]) {
  if (botIds.length === 0) return;
  const marked = { botId: { in: botIds }, resumeOnRestore: true, bot: { archivedAt: null } };
  const routines = await deps.prisma.routine.findMany({
    where: marked,
    select: { id: true, spaceId: true, crons: true, timezone: true, watch: true },
  });
  if (routines.length === 0) return;
  const now = new Date();
  const wakeups: Array<{ id: string; nextRunAt: Date }> = [];
  for (const routine of routines) {
    if (isOneShotRoutineCrons(routine.crons)) continue;
    const nextRunAt =
      routine.watch != null
        ? firstWatchCheck()
        : nextCronDateAcross(routine.crons, now, routine.timezone);
    // Only while it is still marked and its bot is still restored: an archive that lands in
    // between keeps it off.
    const resumed = await deps.prisma.routine.updateMany({
      where: { ...marked, id: routine.id, active: false },
      data: { active: true, nextRunAt, resumeOnRestore: false },
    });
    if (resumed.count === 1 && nextRunAt) wakeups.push({ id: routine.id, nextRunAt });
  }
  await deps.prisma.routine.updateMany({
    where: { ...marked, id: { in: routines.map((routine) => routine.id) } },
    data: { resumeOnRestore: false },
  });
  for (const { id, nextRunAt } of wakeups) await deps.jobs.enqueue(routineWakeupJob(id, nextRunAt));
  for (const spaceId of new Set(routines.map((routine) => routine.spaceId)))
    await deps.events?.publishSpaceChange?.(spaceId, "routines");
}
