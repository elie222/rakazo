import type { PrismaClient } from "@rakazo/db";

type RecoveryRun = { id: string; botId: string; bot: { computerId: string | null } };

/** Leave resource waits untouched so recovery preserves their age and execution history. */
export async function findRunRecoveryBlockers(
  prisma: PrismaClient,
  runs: readonly RecoveryRun[],
  now: Date,
): Promise<Map<string, string>> {
  const leases = runs.length
    ? await prisma.computerExecutionLease.findMany({
        where: { botId: { in: runs.map((run) => run.botId) }, expiresAt: { gt: now } },
        select: { computerId: true, botId: true, runId: true },
      })
    : [];
  const blockers = new Map<string, string>();
  for (const run of runs) {
    const lease = leases.find(
      (lease) =>
        lease.botId === run.botId &&
        lease.computerId === run.bot.computerId &&
        lease.runId !== run.id,
    );
    if (lease) blockers.set(run.id, lease.runId);
  }
  return blockers;
}
