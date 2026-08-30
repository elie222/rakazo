import type { PrismaClient } from "@rakazo/db";

export type EvaluationLease = Readonly<{
  owner: string;
  fence: number;
  expiresAt: Date;
}>;

/**
 * Acquires the durable, fenced ownership token for one employee evaluation.
 *
 * `updateMany` is intentionally conditional on lease expiry. PostgreSQL
 * rechecks that predicate after a concurrent row update, so duplicate
 * at-least-once jobs cannot both claim a currently unowned runtime row. The
 * returned fence must be supplied when releasing or committing follow-up work.
 */
export async function acquireEmployeeEvaluationLease(
  prisma: PrismaClient,
  input: { workspaceId: string; botId: string; owner: string; now?: Date; durationMs?: number },
): Promise<EvaluationLease | null> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.durationMs ?? 60_000));
  const claimed = await prisma.employeeRuntimeState.updateMany({
    where: {
      workspaceId: input.workspaceId,
      botId: input.botId,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    data: {
      leaseOwner: input.owner,
      leaseExpiresAt: expiresAt,
      leaseFence: { increment: 1 },
      status: "evaluating",
      lastActiveAt: now,
      lastEvaluationAt: now,
    },
  });
  if (claimed.count !== 1) return null;

  const runtime = await prisma.employeeRuntimeState.findFirst({
    where: { workspaceId: input.workspaceId, botId: input.botId, leaseOwner: input.owner },
    select: { leaseFence: true },
  });
  if (!runtime) return null;
  return { owner: input.owner, fence: runtime.leaseFence, expiresAt };
}

export async function releaseEmployeeEvaluationLease(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    botId: string;
    lease: EvaluationLease;
    status: "idle" | "working" | "blocked" | "waiting_approval" | "sleeping";
    nextWakeAt?: Date | null;
  },
): Promise<boolean> {
  const released = await prisma.employeeRuntimeState.updateMany({
    where: {
      workspaceId: input.workspaceId,
      botId: input.botId,
      leaseOwner: input.lease.owner,
      leaseFence: input.lease.fence,
    },
    data: {
      status: input.status,
      nextWakeAt: input.nextWakeAt ?? null,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
  return released.count === 1;
}
