import type { MessageBlock } from "@rakazo/contracts";
import type { StuckWorkStatus } from "@rakazo/core";
import { ACTIVE_RUN_STATUSES, stuckWorkExpiredNonce, stuckWorkStatusMessage } from "@rakazo/core";
import type { Prisma } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import { appendEventInTransaction, createPendingSteeringRun } from "./events.js";
import { createThreadMessageInTransaction } from "./messages.js";

export interface ExpireStuckRunInput {
  runId: string;
  threadId: string;
  status: StuckWorkStatus;
  /** Episode clock. A newer claim or answer changes updatedAt and must win. */
  updatedAt: Date;
  now: Date;
}

export interface ExpireStuckRunResult {
  seq: number;
  continuationRunId: string | null;
}

/**
 * Cancel one aged queued run or human wait. Sets `error` to the status line so
 * a stuck cancel can be told from a user stop, which leaves error empty.
 * Returns null when the row already moved on.
 */
export async function expireStuckRun(
  tx: Prisma.TransactionClient,
  input: ExpireStuckRunInput,
): Promise<ExpireStuckRunResult | null> {
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
  const current = await tx.run.findUnique({
    where: { id: input.runId },
    select: { status: true, updatedAt: true },
  });
  // Re-read so the fence uses the same timestamp precision Prisma just loaded.
  if (
    !current ||
    current.status !== input.status ||
    current.updatedAt.getTime() !== input.updatedAt.getTime()
  ) {
    return null;
  }
  const cancelled = await tx.run.updateMany({
    where: { id: input.runId, status: input.status, updatedAt: current.updatedAt },
    data: {
      status: "cancelled",
      error: stuckWorkStatusMessage(input.status),
      completedAt: input.now,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
  if (cancelled.count !== 1) return null;

  await tx.attempt.updateMany({
    where: {
      runId: input.runId,
      status: { in: ["running", "waiting_input", "waiting_takeover"] },
    },
    data: { status: "cancelled", finishedAt: input.now },
  });

  const run = await tx.run.findUniqueOrThrow({
    where: { id: input.runId },
    select: { spaceId: true, threadId: true, botId: true, taskId: true },
  });
  const sibling = await tx.run.findFirst({
    where: {
      taskId: run.taskId,
      id: { not: input.runId },
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    select: { id: true },
  });
  if (!sibling) {
    await tx.task.updateMany({
      where: { id: run.taskId },
      data: { status: "cancelled" },
    });
  }

  const text = stuckWorkStatusMessage(input.status);
  const blocks: MessageBlock[] = [{ kind: "meta", text }];
  const message = await createThreadMessageInTransaction(tx, {
    threadId: run.threadId,
    role: "system",
    blocks,
    botId: run.botId,
    clientNonce: stuckWorkExpiredNonce(input.runId),
    markUnread: true,
  });
  await appendEventInTransaction(tx, {
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    type: "thread.message.created",
    payload: { messageId: message.id, role: "system", blocks },
  });
  const cancelledEvent = await appendEventInTransaction(tx, {
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    type: "run.cancelled",
    runId: input.runId,
    payload: {},
  });
  await tx.event.deleteMany({ where: { runId: input.runId, type: "thread.progress" } });
  await expireComputerExecutionLeases(tx, { runId: input.runId });
  // A user lease still on this row is on the screen until release or revocation.
  // Dropping controlRunId first makes maintenance treat the takeover as idle.
  await tx.computer.updateMany({
    where: {
      controlRunId: input.runId,
      OR: [{ controlHolder: { not: "user" } }, { controlLeaseId: null }],
    },
    data: { controlRunId: null },
  });
  await tx.computer.updateMany({
    where: { executionRunId: input.runId },
    data: {
      executionRunId: null,
      executionBotId: null,
      executionLeaseExpiresAt: null,
    },
  });
  await tx.steeringMessage.updateMany({
    where: { runId: input.runId },
    data: { runId: null, claimedAt: null },
  });
  const continuationRunId = await createPendingSteeringRun(tx, {
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
  });
  return { seq: cancelledEvent.seq, continuationRunId };
}
