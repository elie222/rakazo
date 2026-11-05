import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { clearRoutineBackoff } from "./routine-backoff.js";

/**
 * After a routine changes hands: occurrences queued but not yet started run with the new owner's
 * accounts, and backoff earned on the previous owner's does not hold them back. A run already
 * under way finishes as the person who started it.
 */
export async function finishRoutineHandover(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  routine: { id: string; previousUserId: string; userId: string },
): Promise<void> {
  const moved = await deps.prisma.run.updateManyAndReturn({
    // Only while the routine is still theirs: a later edit's handover wins over a late one.
    where: {
      routineId: routine.id,
      userId: routine.previousUserId,
      status: "queued",
      routine: { userId: routine.userId },
    },
    data: { userId: routine.userId },
    select: { taskId: true },
  });
  if (moved.length > 0) {
    await deps.prisma.task.updateMany({
      where: { id: { in: moved.map((run) => run.taskId) } },
      data: { userId: routine.userId },
    });
  }
  await clearRoutineBackoff(deps, { routineId: routine.id });
}
