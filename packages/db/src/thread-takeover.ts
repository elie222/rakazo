import type { RealtimeFanout } from "@rakazo/adapter-kit";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import { releasedTakeoverComputerBlocks } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { hasActiveComputerControl, holdsUserControl } from "./computers.js";
import { notifyRealtime } from "./event-stream.js";
import { appendEventInTransaction, transientRunEventsWhere } from "./events.js";
import type { RunLease } from "./messages.js";
import { THREAD_LOCK_TRANSACTION_OPTIONS } from "./transaction-retry.js";

export interface FinalizeComputerControlReleaseInput {
  spaceId: string;
  computerId: string;
  botId: string;
  runId: string | null;
  leaseId: string | null;
  holder: "bot" | "none";
  reason: "done" | "expired" | "released" | "skipped";
}

export interface FinalizeComputerControlReleaseResult {
  runId: string | null;
}

export interface PauseRunForTakeover {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
  reason: string;
  /** Computer that should expose the pending takeover to the UI via controlRunId. */
  computerId: string;
}

export async function pauseRunForTakeover(
  prisma: PrismaClient,
  input: PauseRunForTakeover,
  realtime?: RealtimeFanout,
): Promise<boolean | { continuationRunId: string }> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Release and pause both lock computer, then thread, then run.
    await tx.$queryRaw`
      SELECT id FROM computers WHERE id = ${input.computerId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const run = await tx.run.findUnique({
      where: { id: input.runId },
      select: { checkpoint: true, userId: true },
    });
    const released = run?.checkpoint === "takeover" || run?.checkpoint === "takeover-skipped";
    const paused = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: released ? "queued" : "waiting_takeover",
        leaseOwner: null,
        leaseExpiresAt: null,
        checkpoint: released ? run.checkpoint : null,
      },
    });
    if (paused.count !== 1) return null;

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: { status: released ? "interrupted" : "waiting_takeover", finishedAt: new Date() },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to pause");

    // A release can finish while the runtime is still preparing its pause. Keep its
    // checkpoint and continue instead of recreating a wait with no control lease.
    if (released) {
      const seq = await settleReleasedTakeoverCardsInTransaction(tx, {
        ...input,
        reason: run.checkpoint === "takeover-skipped" ? "skipped" : "done",
      });
      return { threadId: input.threadId, seq, continuationRunId: input.runId };
    }

    const now = new Date();
    const computer = await tx.computer.findFirst({
      where: { id: input.computerId, spaceId: input.spaceId },
      select: {
        controlHolder: true,
        controlBotId: true,
        controlLeaseId: true,
        controlLeaseExpiresAt: true,
        controlUserId: true,
        userId: true,
      },
    });
    const activeUserLease = hasActiveComputerControl(computer, now);
    // Keep an active same-bot user lease so Skip / I'm done appear immediately.
    // Preserve another bot's active lease — computer/takeover owns revocation. Do not attach
    // this run to that lease: release validates controlBotId and could clear the binding without
    // resuming the waiting run. The requesting bot's takeover flow binds it after revocation.
    // Otherwise clear stale control, but bind controlRunId so takeoverRequested is true.
    // In a shared Space the lease must also be this run's person's: another member's stays
    // theirs, like another bot's, and never answers this run.
    const retainControl = Boolean(
      activeUserLease &&
        computer?.controlBotId === input.botId &&
        run &&
        holdsUserControl(computer, run.userId),
    );
    const preserveForeignLease = Boolean(
      activeUserLease && computer?.controlBotId && !retainControl,
    );
    const marked = await tx.computer.updateMany({
      where: { id: input.computerId, spaceId: input.spaceId },
      data: retainControl
        ? { state: "running", controlRunId: input.runId }
        : preserveForeignLease
          ? { state: "running" }
          : {
              state: "running",
              controlHolder: "none",
              controlLeaseId: null,
              controlUserId: null,
              controlLeaseExpiresAt: null,
              controlBotId: null,
              controlRunId: input.runId,
            },
    });
    if (marked.count !== 1) throw new Error("Computer was not available to mark for takeover");

    const waitingEvent = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "computer.takeover.requested",
      runId: input.runId,
      payload: {
        reason: input.reason,
        takeoverRequested: true,
        retainedControl: retainControl,
      },
    });
    await tx.event.deleteMany({
      where: { runId: input.runId, ...transientRunEventsWhere() },
    });
    return { threadId: waitingEvent.threadId, seq: waitingEvent.seq, continuationRunId: null };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);

  if (!committed) return false;
  if (committed.seq !== null) {
    await notifyRealtime(realtime, committed.threadId, committed.seq);
  }
  return committed.continuationRunId ? { continuationRunId: committed.continuationRunId } : true;
}

export async function finalizeComputerControlRelease(
  prisma: PrismaClient,
  input: FinalizeComputerControlReleaseInput,
  realtime?: RealtimeFanout,
): Promise<FinalizeComputerControlReleaseResult | false> {
  if (!input.leaseId && !input.runId) return false;
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`
      SELECT id FROM computers WHERE id = ${input.computerId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
    // The same lease can acquire a run binding while provider revocation is in flight.
    // Fence by lease identity, then finalize the current binding under the row lock.
    const computer = await tx.computer.findFirst({
      where: { id: input.computerId, spaceId: input.spaceId },
      select: { controlRunId: true },
    });
    const controlRunId = input.leaseId ? (computer?.controlRunId ?? null) : input.runId;
    let waiting = controlRunId
      ? await tx.run.findUnique({
          where: { id: controlRunId },
          select: { threadId: true, status: true },
        })
      : null;
    const runThreadId = waiting?.threadId ?? null;
    if (runThreadId) {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${runThreadId} FOR UPDATE`;
      waiting = await tx.run.findUnique({
        where: { id: controlRunId! },
        select: { threadId: true, status: true },
      });
    }
    const cleared = await tx.computer.updateMany({
      where: input.leaseId
        ? {
            id: input.computerId,
            spaceId: input.spaceId,
            controlBotId: input.botId,
            controlLeaseId: input.leaseId,
            controlRunId,
          }
        : {
            id: input.computerId,
            spaceId: input.spaceId,
            controlHolder: "none",
            controlBotId: null,
            controlLeaseId: null,
            controlRunId,
          },
      data: {
        controlHolder: input.holder,
        controlLeaseId: null,
        controlUserId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
      },
    });
    if (cleared.count !== 1) return null;

    const checkpoint =
      input.reason === "skipped" || input.reason === "expired" ? "takeover-skipped" : "takeover";
    const resumed = controlRunId
      ? await tx.run.updateMany({
          where: {
            id: controlRunId,
            spaceId: input.spaceId,
            botId: input.botId,
            status: "waiting_takeover",
          },
          data: {
            status: "queued",
            checkpoint,
          },
        })
      : { count: 0 };
    // A steered continue may already hold the run as leased/running. Stamp the
    // checkpoint without stealing the lease so the worker can restore tools.
    const stamped =
      controlRunId && resumed.count !== 1
        ? await tx.run.updateMany({
            where: {
              id: controlRunId,
              spaceId: input.spaceId,
              botId: input.botId,
              status: { in: ["leased", "running"] },
            },
            data: { checkpoint },
          })
        : { count: 0 };
    const runId = resumed.count === 1 || stamped.count === 1 ? controlRunId : null;

    const bot = await tx.bot.findFirst({
      where: { id: input.botId, spaceId: input.spaceId },
      select: { thread: { select: { id: true } } },
    });
    if (!bot?.thread) return { threadId: null, seq: null, runId };

    // Group cards live on the run's thread. Stopped runs cannot write history.
    if (controlRunId && runThreadId && waiting?.status !== "cancelled") {
      await settleReleasedTakeoverCardsInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: runThreadId,
        botId: input.botId,
        runId: controlRunId,
        reason: input.reason,
      });
    }

    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: runThreadId ?? bot.thread.id,
      botId: input.botId,
      runId: runId ?? undefined,
      type: "computer.takeover.released",
      payload: {
        holder: input.holder,
        leaseId: input.leaseId,
        reason: input.reason,
      },
    });
    return { threadId: event.threadId, seq: event.seq, runId };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);

  if (!committed) return false;
  if (committed.threadId && committed.seq !== null) {
    await notifyRealtime(realtime, committed.threadId, committed.seq);
  }
  return { runId: committed.runId };
}

/**
 * Clear a pending takeover computer card when the run resumes.
 * Release already settles the card; this covers a card that is still pending.
 * No message write and no notify when nothing is pending.
 */
export async function settleReleasedTakeoverCards(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    threadId: string;
    botId: string;
    runId: string;
    reason: unknown;
    lease?: RunLease;
  },
  notify?: (threadId: string, seq: number) => Promise<void>,
): Promise<void> {
  const seq = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    return settleReleasedTakeoverCardsInTransaction(tx, input);
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (seq !== null) await notify?.(input.threadId, seq);
}

async function settleReleasedTakeoverCardsInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    threadId: string;
    botId: string;
    runId: string;
    reason: unknown;
    lease?: RunLease;
  },
): Promise<number | null> {
  const messages = await tx.message.findMany({
    where: { threadId: input.threadId, runId: input.runId, role: "bot" },
    select: { id: true, blocks: true },
  });
  let lastSeq: number | null = null;
  for (const message of messages) {
    const parsed = MessageBlockSchema.array().safeParse(message.blocks);
    if (!parsed.success) continue;
    const blocks = releasedTakeoverComputerBlocks(parsed.data, input.reason);
    if (!blocks) continue;
    await tx.message.update({
      where: { id: message.id },
      data: { blocks: blocks as Prisma.InputJsonValue },
    });
    const updated = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "thread.message.updated",
      runId: input.runId,
      lease: input.lease,
      payload: { messageId: message.id, role: "bot", blocks },
    });
    lastSeq = updated.seq;
  }
  return lastSeq;
}
