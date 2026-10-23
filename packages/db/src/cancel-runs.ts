import type { Prisma } from "./client.js";
import { RUN_TURN_CHECKPOINT_KIND } from "./run-turn-checkpoint.js";

/** The caller selects authorized runs and owns the surrounding transaction and cleanup. */
export async function cancelRunsInTransaction(
  tx: Pick<Prisma.TransactionClient, "run" | "attempt" | "task" | "externalEffect">,
  runs: ReadonlyArray<{ id: string; taskId: string }>,
  cancelledAt: Date,
): Promise<void> {
  if (runs.length === 0) return;
  const runIds = runs.map((run) => run.id);
  await tx.run.updateMany({
    where: { id: { in: runIds } },
    data: {
      status: "cancelled",
      completedAt: cancelledAt,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
  await tx.externalEffect.deleteMany({
    where: {
      runId: { in: runIds },
      kind: RUN_TURN_CHECKPOINT_KIND,
      status: RUN_TURN_CHECKPOINT_KIND,
    },
  });
  await tx.attempt.updateMany({
    where: { runId: { in: runIds }, status: "running" },
    data: { status: "cancelled", finishedAt: cancelledAt },
  });
  await tx.task.updateMany({
    where: { id: { in: runs.map((run) => run.taskId) } },
    data: { status: "cancelled" },
  });
}
