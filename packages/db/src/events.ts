import type { RealtimeFanout } from "@rakazo/adapter-kit";
import type { MessageBlock, ProductEvent } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { createThreadMessageInTransaction } from "./messages.js";

const EVENT_BATCH_SIZE = 200;
const PUSH_CATCH_UP_MS = 30_000;
const POLL_ONLY_CATCH_UP_MS = 400;

export interface AppendEventInput {
  workspaceId: string;
  threadId: string;
  botId: string;
  type: ProductEvent["type"];
  payload: Record<string, unknown>;
  runId?: string;
}

export interface ThreadEvents {
  append(input: AppendEventInput): Promise<ProductEvent>;
  finalizeComputerControlRelease(input: FinalizeComputerControlReleaseInput): Promise<boolean>;
  finalizeRun(input: FinalizeRunInput): Promise<boolean>;
  follow(threadId: string, cursor: number, signal?: AbortSignal): AsyncGenerator<ProductEvent>;
}

export interface FinalizeComputerControlReleaseInput {
  workspaceId: string;
  botId: string;
  leaseId: string;
  holder: "bot" | "none";
  reason: "expired" | "released";
}

interface FinalizeRunBase {
  workspaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  taskId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
}

export type FinalizeRunInput = FinalizeRunBase &
  ({ outcome: "completed"; blocks: MessageBlock[] } | { outcome: "failed"; error: string });

export function createThreadEvents(
  prisma: PrismaClient,
  realtime?: RealtimeFanout,
  options: { catchUpMs?: number } = {},
): ThreadEvents {
  return {
    append: (input) => appendEvent(prisma, input, realtime),
    finalizeComputerControlRelease: (input) =>
      finalizeComputerControlRelease(prisma, input, realtime),
    finalizeRun: (input) => finalizeRun(prisma, input, realtime),
    follow: (threadId, cursor, signal) =>
      followThreadEvents(prisma, threadId, cursor, realtime, signal, options.catchUpMs),
  };
}

export async function finalizeComputerControlRelease(
  prisma: PrismaClient,
  input: FinalizeComputerControlReleaseInput,
  realtime?: RealtimeFanout,
): Promise<boolean> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const cleared = await tx.computer.updateMany({
      where: { botId: input.botId, controlLeaseId: input.leaseId },
      data: {
        controlHolder: input.holder,
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
      },
    });
    if (cleared.count !== 1) return null;

    const bot = await tx.bot.findUnique({
      where: { id: input.botId },
      select: { thread: { select: { id: true } } },
    });
    if (!bot?.thread) return { threadId: null, seq: null };
    const event = await appendEventInTransaction(tx, {
      workspaceId: input.workspaceId,
      threadId: bot.thread.id,
      botId: input.botId,
      type: "computer.takeover.released",
      payload: {
        holder: input.holder,
        leaseId: input.leaseId,
        reason: input.reason,
      },
    });
    return { threadId: event.threadId, seq: event.seq };
  });

  if (!committed) return false;
  if (committed.threadId && committed.seq !== null) {
    await notifyRealtime(realtime, committed.threadId, committed.seq);
  }
  return true;
}

export async function appendEvent(
  prisma: PrismaClient,
  input: AppendEventInput,
  realtime?: RealtimeFanout,
): Promise<ProductEvent> {
  const event = await prisma.$transaction((tx: Prisma.TransactionClient) =>
    appendEventInTransaction(tx, input),
  );
  const productEvent = mapProductEvent(event);
  await notifyRealtime(realtime, event.threadId, event.seq);
  return productEvent;
}

export async function finalizeRun(
  prisma: PrismaClient,
  input: FinalizeRunInput,
  realtime?: RealtimeFanout,
): Promise<boolean> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const now = new Date();
    const terminal = await tx.run.updateMany({
      where: {
        id: input.runId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        botId: input.botId,
        taskId: input.taskId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: input.outcome,
        error: input.outcome === "failed" ? input.error : null,
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    if (terminal.count !== 1) return null;

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: {
        status: input.outcome,
        error: input.outcome === "failed" ? input.error : null,
        finishedAt: now,
      },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to finalize");

    const task = await tx.task.updateMany({
      where: {
        id: input.taskId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        botId: input.botId,
      },
      data: { status: input.outcome },
    });
    if (task.count !== 1) throw new Error("Run task was not available to finalize");

    if (input.outcome === "completed") {
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: "bot",
        blocks: input.blocks,
        runId: input.runId,
      });
      await appendEventInTransaction(tx, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.created",
        runId: input.runId,
        payload: { messageId: message.id, role: "bot", blocks: input.blocks },
      });
    }
    const lastEvent = await appendEventInTransaction(tx, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: input.outcome === "completed" ? "run.completed" : "run.failed",
      runId: input.runId,
      payload: input.outcome === "completed" ? {} : { error: input.error },
    });
    await tx.event.deleteMany({ where: { runId: input.runId, type: "thread.progress" } });
    await tx.bot.update({ where: { id: input.botId }, data: { updatedAt: now } });
    return { threadId: lastEvent.threadId, seq: lastEvent.seq };
  });

  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return true;
}

async function appendEventInTransaction(tx: Prisma.TransactionClient, input: AppendEventInput) {
  const thread = await tx.thread.update({
    where: { id: input.threadId },
    data: { nextEventSeq: { increment: 1 } },
    select: { nextEventSeq: true },
  });
  return tx.event.create({
    data: {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      botId: input.botId,
      seq: thread.nextEventSeq - 1,
      type: input.type,
      payload: input.payload as Prisma.InputJsonValue,
      runId: input.runId,
    },
  });
}

async function notifyRealtime(
  realtime: RealtimeFanout | undefined,
  threadId: string,
  cursor: number,
): Promise<void> {
  await realtime?.publish(threadTopic(threadId), JSON.stringify({ cursor })).catch(() => undefined);
}

export async function eventsAfter(
  prisma: PrismaClient,
  threadId: string,
  cursor: number,
  limit?: number,
) {
  return prisma.event.findMany({
    where: { threadId, seq: { gt: cursor } },
    orderBy: { seq: "asc" },
    ...(limit ? { take: limit } : {}),
  });
}

export async function* followThreadEvents(
  prisma: PrismaClient,
  threadId: string,
  cursor: number,
  realtime?: RealtimeFanout,
  signal?: AbortSignal,
  catchUpMs = realtime ? PUSH_CATCH_UP_MS : POLL_ONLY_CATCH_UP_MS,
): AsyncGenerator<ProductEvent> {
  let seq = cursor;
  const latch = new ChangeLatch();
  const unsubscribe = realtime
    ? await realtime
        .subscribe(threadTopic(threadId), () => latch.notify())
        .catch(() => async () => {})
    : async () => {};
  try {
    while (!signal?.aborted) {
      const observedGeneration = latch.generation;
      let batchSize = 0;
      do {
        const events = await eventsAfter(prisma, threadId, seq, EVENT_BATCH_SIZE);
        batchSize = events.length;
        for (const event of events) {
          seq = event.seq;
          yield mapProductEvent(event);
        }
      } while (batchSize === EVENT_BATCH_SIZE && !signal?.aborted);
      if (signal?.aborted) break;
      await latch.waitForChange(observedGeneration, catchUpMs, signal);
    }
  } finally {
    await unsubscribe();
  }
}

function threadTopic(threadId: string): string {
  return `thread:${threadId}`;
}

function mapProductEvent(event: {
  id: string;
  workspaceId: string;
  threadId: string;
  botId: string;
  seq: number;
  type: string;
  payload: unknown;
  runId: string | null;
  createdAt: Date;
}): ProductEvent {
  return {
    id: event.id,
    workspaceId: event.workspaceId,
    threadId: event.threadId,
    botId: event.botId,
    seq: event.seq,
    type: event.type as ProductEvent["type"],
    runId: event.runId ?? undefined,
    createdAt: event.createdAt.toISOString(),
    payload: event.payload as Record<string, unknown>,
  };
}

class ChangeLatch {
  generation = 0;
  private wake: (() => void) | undefined;

  notify(): void {
    this.generation += 1;
    this.wake?.();
  }

  async waitForChange(expected: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.generation !== expected || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        if (this.wake === finish) this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.wake = finish;
      signal?.addEventListener("abort", finish, { once: true });
      if (this.generation !== expected || signal?.aborted) finish();
    });
  }
}
