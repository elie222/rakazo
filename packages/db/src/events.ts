import type { RealtimeFanout } from "@rakazo/adapter-kit";
import {
  type MessageBlock,
  MessageBlock as MessageBlockSchema,
  type ProductEvent,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import {
  assertRunCanWriteHistory,
  createThreadMessageInTransaction,
  RunHistoryWriteError,
} from "./messages.js";

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
  answerRunInput(input: AnswerRunInput): Promise<boolean>;
  append(input: AppendEventInput): Promise<ProductEvent>;
  clearThread(input: ClearThreadInput): Promise<ClearThreadResult>;
  finalizeComputerControlRelease(input: FinalizeComputerControlReleaseInput): Promise<boolean>;
  finalizeRun(input: FinalizeRunInput): Promise<boolean>;
  notify(threadId: string, seq: number): Promise<void>;
  pauseRunForInput(input: PauseRunForInput): Promise<boolean>;
  sendUserMessage(input: SendUserMessageInput): Promise<SendUserMessageResult>;
  follow(threadId: string, cursor: number, signal?: AbortSignal): AsyncGenerator<ProductEvent>;
}

export interface ClearThreadInput {
  workspaceId: string;
  threadId: string;
  botId: string;
}

export interface ClearThreadResult {
  event: ProductEvent;
  cancelledRunIds: string[];
  historyCompactionGeneration: number;
}

export interface FinalizeComputerControlReleaseInput {
  workspaceId: string;
  computerId: string;
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

export interface PauseRunForInput {
  workspaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
  blocks: MessageBlock[];
}

export interface AnswerRunInput {
  workspaceId: string;
  threadId: string;
  runId: string;
  messageId: string;
  answer: string;
}

export interface SendUserMessageInput {
  workspaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  blocks: MessageBlock[];
  prompt: string;
  trigger: "user" | "follow_up";
  clientNonce?: string;
  /** Skip task/run creation when the bot already has active work (follow-up behavior). */
  onlyIfIdle?: boolean;
  linkMessageToRun?: boolean;
}

export interface SendUserMessageResult {
  messageId: string;
  seq: number;
  taskId: string | null;
  runId: string | null;
}

export function createThreadEvents(
  prisma: PrismaClient,
  realtime?: RealtimeFanout,
  options: { catchUpMs?: number } = {},
): ThreadEvents {
  return {
    answerRunInput: (input) => answerRunInput(prisma, input, realtime),
    append: (input) => appendEvent(prisma, input, realtime),
    clearThread: (input) => clearThread(prisma, input, realtime),
    finalizeComputerControlRelease: (input) =>
      finalizeComputerControlRelease(prisma, input, realtime),
    finalizeRun: (input) => finalizeRun(prisma, input, realtime),
    notify: (threadId, seq) => notifyRealtime(realtime, threadId, seq),
    pauseRunForInput: (input) => pauseRunForInput(prisma, input, realtime),
    sendUserMessage: (input) => sendUserMessage(prisma, input, realtime),
    follow: (threadId, cursor, signal) =>
      followThreadEvents(prisma, threadId, cursor, realtime, signal, options.catchUpMs),
  };
}

export async function clearThread(
  prisma: PrismaClient,
  input: ClearThreadInput,
  realtime?: RealtimeFanout,
): Promise<ClearThreadResult> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const thread = await tx.thread.update({
      where: {
        id: input.threadId,
        workspaceId: input.workspaceId,
        botId: input.botId,
      },
      data: { unread: false },
      select: { nextMessageSeq: true, historyCompactionGeneration: true },
    });
    const activeRuns = await tx.run.findMany({
      where: {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        botId: input.botId,
        status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
      },
      select: { id: true, taskId: true },
    });
    const now = new Date();
    const runIds = activeRuns.map((run) => run.id);
    const taskIds = activeRuns.map((run) => run.taskId);
    if (runIds.length > 0) {
      await tx.run.updateMany({
        where: { id: { in: runIds } },
        data: {
          status: "cancelled",
          completedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      await tx.attempt.updateMany({
        where: { runId: { in: runIds }, status: "running" },
        data: { status: "cancelled", finishedAt: now },
      });
      await tx.task.updateMany({
        where: { id: { in: taskIds } },
        data: { status: "cancelled" },
      });
    }
    await tx.computerExecutionLease.deleteMany({ where: { botId: input.botId } });
    await tx.computer.updateMany({
      where: { executionBotId: input.botId },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
    await tx.message.deleteMany({ where: { threadId: input.threadId } });
    await tx.event.deleteMany({ where: { threadId: input.threadId } });
    if (thread.nextMessageSeq > 0) {
      // nextMessageSeq is not reset, so mark every deleted message as already compacted.
      // Leaving the cursor behind would let compaction re-summarize deleted history (or, reset
      // to null, immediately re-fire on the fresh conversation).
      await tx.thread.update({
        where: { id: input.threadId },
        data: {
          historyCompactedUpToSeq: thread.nextMessageSeq - 1,
          historyCompactionSummary: null,
          historyCompactionGeneration: { increment: 1 },
        },
      });
    } else {
      await tx.thread.update({
        where: { id: input.threadId },
        data: {
          historyCompactionSummary: null,
          historyCompactionGeneration: { increment: 1 },
        },
      });
    }
    await tx.bot.update({
      where: { id: input.botId, workspaceId: input.workspaceId },
      data: { updatedAt: now },
    });
    const event = await appendEventInTransaction(tx, {
      ...input,
      type: "thread.cleared",
      payload: {},
    });
    return {
      event,
      cancelledRunIds: runIds,
      historyCompactionGeneration: thread.historyCompactionGeneration,
    };
  });
  await notifyRealtime(realtime, committed.event.threadId, committed.event.seq);
  return {
    event: mapProductEvent(committed.event),
    cancelledRunIds: committed.cancelledRunIds,
    historyCompactionGeneration: committed.historyCompactionGeneration,
  };
}

export async function sendUserMessage(
  prisma: PrismaClient,
  input: SendUserMessageInput,
  realtime?: RealtimeFanout,
): Promise<SendUserMessageResult> {
  const replay = async (): Promise<SendUserMessageResult | null> => {
    if (!input.clientNonce) return null;
    const message = await prisma.message.findUnique({
      where: {
        threadId_clientNonce: {
          threadId: input.threadId,
          clientNonce: input.clientNonce,
        },
      },
      include: { sourceRuns: { orderBy: { createdAt: "asc" }, take: 1 } },
    });
    if (!message) return null;
    const run = message.sourceRuns[0] ?? null;
    return {
      messageId: message.id,
      seq: message.seq,
      taskId: run?.taskId ?? null,
      runId: run?.id ?? null,
    };
  };
  const existing = await replay();
  if (existing) return existing;

  const commit = () =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Message first: its thread-row lock serializes the whole send against clearThread, so a
      // concurrent clear either sees the committed run and cancels it, or strictly precedes this
      // transaction. Created in separate transactions, the run could land inside the clear's
      // window and later repopulate the cleared conversation, and a clear could strand the
      // message without its event.
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: "user",
        blocks: input.blocks,
        clientNonce: input.clientNonce,
      });
      const busy = input.onlyIfIdle
        ? await tx.run.findFirst({
            where: { botId: input.botId, status: { in: ["running", "queued", "leased"] } },
            select: { id: true },
          })
        : null;
      let task = null;
      let run = null;
      if (!busy) {
        task = await tx.task.create({
          data: {
            workspaceId: input.workspaceId,
            botId: input.botId,
            threadId: input.threadId,
            userId: input.userId,
            prompt: input.prompt,
            status: "queued",
          },
        });
        run = await tx.run.create({
          data: {
            workspaceId: input.workspaceId,
            botId: input.botId,
            threadId: input.threadId,
            taskId: task.id,
            userId: input.userId,
            status: "queued",
            trigger: input.trigger,
            clientNonce: input.clientNonce ? `send:${message.id}` : undefined,
            sourceMessageId: message.id,
          },
        });
        if (input.linkMessageToRun) {
          await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
        }
      }
      const event = await appendEventInTransaction(tx, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.created",
        runId: run?.id,
        payload: { messageId: message.id, role: "user", blocks: input.blocks },
      });
      return { message, task, run, event };
    });
  const committed = await commit().catch(async (error) => {
    const winner = await replay();
    if (winner) return { replay: winner } as const;
    throw error;
  });
  if ("replay" in committed) return committed.replay;
  await notifyRealtime(realtime, input.threadId, committed.event.seq).catch((error) => {
    // The event is durable; subscribers recover it from their persisted cursor.
    console.error("user message realtime notification", error);
  });
  return {
    messageId: committed.message.id,
    seq: committed.message.seq,
    taskId: committed.task?.id ?? null,
    runId: committed.run?.id ?? null,
  };
}

export async function answerRunInput(
  prisma: PrismaClient,
  input: AnswerRunInput,
  realtime?: RealtimeFanout,
): Promise<boolean> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Thread row first, then run rows — the same order as clearThread and finalizeRun, so a
    // concurrent clear cannot deadlock against this transaction.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const run = await tx.run.findFirst({
      where: {
        id: input.runId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        status: "waiting_input",
      },
      select: { botId: true },
    });
    if (!run) return null;
    const message = await tx.message.findFirst({
      where: {
        id: input.messageId,
        threadId: input.threadId,
        runId: input.runId,
        role: "bot",
      },
    });
    const parsed = MessageBlockSchema.array().safeParse(message?.blocks);
    if (!message || !parsed.success) return null;
    const pendingAsk = parsed.data.find(
      (block) => block.kind === "ask" && block.status !== "answered",
    );
    if (!pendingAsk) return null;

    const queued = await tx.run.updateMany({
      where: {
        id: input.runId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        status: "waiting_input",
      },
      data: { status: "queued" },
    });
    if (queued.count !== 1) return null;

    const task = await tx.task.updateMany({
      where: { runs: { some: { id: input.runId } } },
      data: { prompt: input.answer },
    });
    if (task.count !== 1) throw new Error("Run task was not available to answer");

    const blocks = parsed.data.map((block) =>
      block === pendingAsk
        ? { ...block, status: "answered" as const, answer: input.answer }
        : block,
    );
    await tx.message.update({ where: { id: message.id }, data: { blocks } });
    const updated = await appendEventInTransaction(tx, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      botId: run.botId,
      type: "thread.message.updated",
      runId: input.runId,
      payload: { messageId: message.id, role: "bot", blocks },
    });
    return { threadId: updated.threadId, seq: updated.seq };
  });

  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return true;
}

export async function pauseRunForInput(
  prisma: PrismaClient,
  input: PauseRunForInput,
  realtime?: RealtimeFanout,
): Promise<boolean> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Thread row first, then run rows — the same order as clearThread and finalizeRun, so a
    // concurrent clear cannot deadlock against this transaction.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const paused = await tx.run.updateMany({
      where: {
        id: input.runId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: { status: "waiting_input", leaseOwner: null, leaseExpiresAt: null },
    });
    if (paused.count !== 1) return null;

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: { status: "waiting_input", finishedAt: new Date() },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to pause");

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
    const waitingEvent = await appendEventInTransaction(tx, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "run.waiting_input",
      runId: input.runId,
      payload: {},
    });
    await tx.event.deleteMany({ where: { runId: input.runId, type: "thread.progress" } });
    return { threadId: waitingEvent.threadId, seq: waitingEvent.seq };
  });

  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return true;
}

export async function finalizeComputerControlRelease(
  prisma: PrismaClient,
  input: FinalizeComputerControlReleaseInput,
  realtime?: RealtimeFanout,
): Promise<boolean> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const cleared = await tx.computer.updateMany({
      where: {
        id: input.computerId,
        workspaceId: input.workspaceId,
        controlBotId: input.botId,
        controlLeaseId: input.leaseId,
      },
      data: {
        controlHolder: input.holder,
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
      },
    });
    if (cleared.count !== 1) return null;

    const bot = await tx.bot.findFirst({
      where: { id: input.botId, workspaceId: input.workspaceId },
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
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    try {
      await assertRunCanWriteHistory(tx, input.runId);
    } catch (error) {
      if (error instanceof RunHistoryWriteError) return null;
      throw error;
    }
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
        botId: input.botId,
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

export async function appendEventInTransaction(
  tx: Prisma.TransactionClient,
  input: AppendEventInput,
) {
  const thread = await tx.thread.update({
    where: { id: input.threadId },
    data: { nextEventSeq: { increment: 1 } },
    select: { nextEventSeq: true },
  });
  await assertRunCanWriteHistory(tx, input.runId);
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
