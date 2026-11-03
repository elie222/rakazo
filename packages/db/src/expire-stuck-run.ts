import type { RealtimeFanout } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { StuckWorkStatus } from "@rakazo/core";
import { ACTIVE_RUN_STATUSES, stuckWorkExpiredNonce, stuckWorkStatusMessage } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import {
  appendEventInTransaction,
  createPendingSteeringRun,
  discardAnsweredSteering,
  notifyRealtime,
  transientRunEventsWhere,
} from "./events.js";
import { createThreadMessageInTransaction } from "./messages.js";
import { clearEndedRunState } from "./run-secrets.js";
import { withTransactionRetry } from "./transaction-retry.js";

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
 * Returns null when the row already moved on, or when the user has taken the screen
 * for a takeover wait: handing the screen back or its expiry resumes that run.
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
  if (input.status === "waiting_takeover" && (await userHasTakeoverScreen(tx, input.runId))) {
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
  await clearEndedRunState(tx, [input.runId]);

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
  await tx.event.deleteMany({
    where: { runId: input.runId, ...transientRunEventsWhere() },
  });
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
  await discardAnsweredSteering(tx, { threadId: run.threadId, runId: input.runId });
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

/**
 * End takeover waits that hold up other work for their bot. Each ends through the stuck-work
 * cancel, so the thread gets the same status line, and a wait the user is on the screen for
 * stays. Returns how many ended.
 */
export async function endTakeoverWaits(
  prisma: PrismaClient,
  runIds: string[],
  realtime?: RealtimeFanout,
): Promise<number> {
  const waits = await prisma.run.findMany({
    where: { id: { in: runIds }, status: "waiting_takeover" },
    select: { id: true, threadId: true, updatedAt: true },
  });
  let ended = 0;
  for (const wait of waits) {
    const expired = await withTransactionRetry(() =>
      prisma.$transaction((tx) =>
        expireStuckRun(tx, {
          runId: wait.id,
          threadId: wait.threadId,
          status: "waiting_takeover",
          updatedAt: wait.updatedAt,
          now: new Date(),
        }),
      ),
    );
    if (!expired) continue;
    ended += 1;
    await notifyRealtime(realtime, wait.threadId, expired.seq);
  }
  return ended;
}

/**
 * Whether the user has taken this bot's screen. Any control lease still on the row counts, even
 * an expired one or one mid-release: releasing it resumes the waiting run, which a cancel here
 * would prevent. Locks the computer row, so a concurrent takeover grant either lands first and
 * is seen here, or waits for this cancel.
 */
async function userHasTakeoverScreen(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<boolean> {
  const [computer] = await tx.$queryRaw<
    Array<{ botId: string; controlBotId: string | null; controlLeaseId: string | null }>
  >`
    SELECT r."botId", c."controlBotId", c."controlLeaseId"
    FROM runs r
    JOIN bots b ON b.id = r."botId"
    JOIN computers c ON c.id = b."computerId"
    WHERE r.id = ${runId}
    FOR UPDATE OF c`;
  return Boolean(computer?.controlLeaseId && computer.controlBotId === computer.botId);
}
