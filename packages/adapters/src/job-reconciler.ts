import { type JobPublisher, routineWakeupJob, runContinueJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 100;
const ROUTINE_LOOKAHEAD_MS = 60_000;

export function createJobReconciler(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  options: { intervalMs?: number; batchSize?: number } = {},
) {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reconciling: Promise<void> | undefined;

  const reconcileOnce = async () => {
    if (reconciling) return reconciling;
    reconciling = (async () => {
      const now = new Date();
      const [runs, routines] = await Promise.all([
        deps.prisma.run.findMany({
          where: {
            OR: [
              { status: "queued" },
              {
                status: { in: ["leased", "running"] },
                leaseExpiresAt: { lte: now },
              },
            ],
          },
          orderBy: { updatedAt: "asc" },
          take: batchSize,
          select: { id: true },
        }),
        deps.prisma.routine.findMany({
          where: {
            active: true,
            nextRunAt: { lte: new Date(now.getTime() + ROUTINE_LOOKAHEAD_MS) },
          },
          orderBy: { nextRunAt: "asc" },
          take: batchSize,
          select: { id: true, nextRunAt: true },
        }),
      ]);

      await Promise.all([
        ...runs.map((run) => deps.jobs.enqueue(runContinueJob(run.id))),
        ...routines.flatMap((routine) =>
          routine.nextRunAt
            ? [deps.jobs.enqueue(routineWakeupJob(routine.id, routine.nextRunAt))]
            : [],
        ),
      ]);
    })().finally(() => {
      reconciling = undefined;
    });
    return reconciling;
  };
  const reconcileSafely = () => {
    void reconcileOnce().catch((error) => console.error("background job reconciliation", error));
  };

  return {
    reconcileOnce,
    start() {
      if (timer) return;
      reconcileSafely();
      timer = setInterval(reconcileSafely, intervalMs);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await reconciling?.catch(() => undefined);
    },
  };
}
