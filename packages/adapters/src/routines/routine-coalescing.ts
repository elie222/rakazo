import type { Prisma } from "@rakazo/db";
import { appendEventInTransaction } from "@rakazo/db";

/** Reserved provenance for recurring timer ticks; manual/event/retry runs never use it. */
export function routineTimerNonce(routineId: string, scheduledFor: string): string {
  return `routine-timer:${routineId}:${scheduledFor}`;
}

/** The scheduled occurrence a recurring timer run was created for, if it is one. */
export function routineTimerScheduledFor(
  routineId: string,
  clientNonce: string | null | undefined,
): Date | undefined {
  const prefix = routineTimerNonce(routineId, "");
  if (!clientNonce?.startsWith(prefix)) return undefined;
  const scheduledFor = new Date(clientNonce.slice(prefix.length));
  return Number.isFinite(scheduledFor.getTime()) ? scheduledFor : undefined;
}

const PAGE = 100;

/**
 * Call while holding the routine row lock. Keep at most one unstarted catch-up
 * for the same work; never fold an event, manual test, retry, or actually attempted run.
 */
export async function findPendingRoutineTick(
  tx: Prisma.TransactionClient,
  config: {
    routineId: string;
    spaceId: string;
    botId: string;
    userId: string;
    threadId: string;
    prompt: string;
    modelProvider?: string;
    modelId?: string;
    thinkingLevel?: string | null;
    modelPinned?: true;
  },
) {
  const pristine: Prisma.RunWhereInput = {
    routineId: config.routineId,
    // Older firings did not distinguish recurring ticks from one-shot schedules.
    // Preserve all ambiguous legacy work, even when routine.fired was recorded.
    clientNonce: { startsWith: `routine-timer:${config.routineId}:` },
    spaceId: config.spaceId,
    botId: config.botId,
    userId: config.userId,
    threadId: config.threadId,
    trigger: "routine",
    primaryRuntime: null,
    status: "queued",
    retryOfRunId: null,
    sourceMessageId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    completedAt: null,
    firstResponseAt: null,
    checkpoint: null,
    error: null,
    modelProvider: config.modelProvider ?? null,
    modelId: config.modelId ?? null,
    thinkingLevel: config.thinkingLevel ?? null,
    modelPinned: config.modelPinned ?? false,
    attempts: { none: {} },
    effects: { none: {} },
    steeringMessages: { none: {} },
    task: { status: "queued" },
  };
  // The prompt is encrypted under a fresh IV each time, so it is compared once read back, a page
  // at a time until one keeps a match, so work under an older prompt never hides it.
  let retained: { id: string; taskId: string } | null = null;
  const cancelledEvents: { threadId: string; seq: number }[] = [];
  // Keyset paging: a cursor row claimed by dispatch between pages would make `skip` drop a run.
  let after: { createdAt: Date; id: string } | undefined;
  while (!retained) {
    const page = await tx.run.findMany({
      where: after
        ? {
            ...pristine,
            OR: [
              { createdAt: { gt: after.createdAt } },
              { createdAt: after.createdAt, id: { gt: after.id } },
            ],
          }
        : pristine,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        taskId: true,
        leaseFence: true,
        updatedAt: true,
        createdAt: true,
        task: { select: { prompt: true } },
      },
      take: PAGE,
    });
    const candidates = page.filter(({ task }) => task.prompt === config.prompt);
    const leases = candidates.length
      ? await tx.computerExecutionLease.findMany({
          where: {
            runId: { in: candidates.map((candidate) => candidate.id) },
            expiresAt: { gt: new Date() },
          },
          select: { runId: true },
        })
      : [];
    const held = new Set(leases.map(({ runId }) => runId));
    for (const candidate of candidates) {
      // A stale pre-attempt timestamp/fence does not prove execution. Attempts,
      // effects, checkpoints and live computer ownership do.
      if (held.has(candidate.id)) continue;
      // Dispatch can race the earlier read. Lock and recheck, including its exact
      // fence, so work claimed since the selection is never folded or cancelled.
      const locked = await tx.run.updateMany({
        where: { ...pristine, id: candidate.id, leaseFence: candidate.leaseFence },
        data: retained
          ? {
              status: "cancelled",
              completedAt: new Date(),
              wakeAt: null,
              leaseFence: { increment: 1 },
            }
          : { updatedAt: candidate.updatedAt },
      });
      if (locked.count !== 1) continue;
      if (!retained) {
        retained = { id: candidate.id, taskId: candidate.taskId };
        continue;
      }
      // Keep historical rows and terminal events; only redundant, unstarted timer
      // occurrences disappear from the runnable backlog.
      await tx.task.updateMany({
        where: { id: candidate.taskId, status: "queued", runs: { every: { status: "cancelled" } } },
        data: { status: "cancelled" },
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: config.spaceId,
        threadId: config.threadId,
        botId: config.botId,
        type: "run.cancelled",
        runId: candidate.id,
        payload: { reason: "routine_coalesced", supersededByRunId: retained.id },
      });
      cancelledEvents.push({ threadId: config.threadId, seq: event.seq });
    }
    if (page.length < PAGE) break;
    after = page.at(-1)!;
  }
  return retained && { ...retained, ...(cancelledEvents.length ? { cancelledEvents } : {}) };
}
