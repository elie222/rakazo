import type { MessageBlock } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

/** Group turns use channel inputs and their own outputs, never private thread history. */
export function loadRunHistoryMessages(
  prisma: PrismaClient,
  run: { id: string; threadId: string },
  limit: number,
  channelId?: string,
) {
  return prisma.message.findMany({
    where: {
      threadId: run.threadId,
      ...(channelId
        ? {
            OR: [
              {
                role: "user",
                blocks: { array_contains: [{ kind: "channel_message", channelId }] },
              },
              { role: "bot", runId: run.id },
            ],
          }
        : {}),
    },
    orderBy: { seq: "desc" },
    take: limit,
    select: {
      id: true,
      threadId: true,
      seq: true,
      role: true,
      botId: true,
      runId: true,
      blocks: true,
      createdAt: true,
      replyToMessageId: true,
      replyQuote: true,
      replyTo: { select: { id: true, threadId: true, role: true, botId: true, blocks: true } },
      clientNonce: true,
    },
  });
}

/** Marks the bot message that keeps the reply text of a run that failed partway through it. */
export function partialReplyClientNonce(runId: string): string {
  return `partial-reply:${runId}`;
}

export function isPartialReplyClientNonce(clientNonce: string | null | undefined): boolean {
  return Boolean(clientNonce?.startsWith("partial-reply:"));
}

export interface CreateThreadMessageInput {
  threadId: string;
  role: "user" | "bot" | "system";
  blocks: MessageBlock[];
  botId?: string;
  replyToMessageId?: string;
  replyQuote?: string;
  runId?: string;
  clientNonce?: string;
  markUnread?: boolean;
  /** Terminal echo after the run is already cancelled. Every other write stays rejected. */
  allowCancelledRun?: boolean;
  /** The executing attempt's lease; a superseded attempt cannot write. */
  lease?: RunLease;
}

export async function createThreadMessage(prisma: PrismaClient, input: CreateThreadMessageInput) {
  return withTransactionRetry(() =>
    prisma.$transaction((tx: Prisma.TransactionClient) =>
      createThreadMessageInTransaction(tx, input),
    ),
  );
}

export async function createThreadMessageInTransaction(
  tx: Prisma.TransactionClient,
  input: CreateThreadMessageInput,
) {
  const thread = await tx.thread.update({
    where: { id: input.threadId },
    data: {
      nextMessageSeq: { increment: 1 },
      unread: (input.markUnread ?? input.role === "bot") ? true : undefined,
    },
    select: { nextMessageSeq: true },
  });
  await assertRunCanWriteHistory(tx, input.runId, {
    allowCancelled: input.allowCancelledRun,
    lease: input.lease,
  });
  return tx.message.create({
    data: {
      threadId: input.threadId,
      seq: thread.nextMessageSeq - 1,
      role: input.role,
      blocks: input.blocks as Prisma.InputJsonValue,
      botId: input.botId,
      replyToMessageId: input.replyToMessageId,
      replyQuote: input.replyQuote,
      runId: input.runId,
      clientNonce: input.clientNonce,
    },
  });
}

export class RunHistoryWriteError extends Error {
  constructor() {
    super("Run cannot write thread history");
    this.name = "RunHistoryWriteError";
  }
}

export interface RunLease {
  owner: string;
  fence: number;
}

/**
 * Writes from a run's executing attempt pass its lease. The row stays share-locked until the
 * write commits, so no worker can reclaim the run between this check and the write. Pausing
 * or finishing releases the owner but keeps the fence, so only a newer claim supersedes it.
 */
export async function assertRunCanWriteHistory(
  tx: Prisma.TransactionClient,
  runId?: string,
  options?: { allowCancelled?: boolean; lease?: RunLease },
): Promise<
  | {
      status: string;
      startedAt: Date | null;
      firstResponseAt: Date | null;
      userId: string;
      leaseOwner: string | null;
    }
  | undefined
> {
  if (!runId) return;
  const lease = options?.lease;
  if (lease) await tx.$queryRaw`SELECT id FROM runs WHERE id = ${runId} FOR SHARE`;
  const run = await tx.run.findUnique({
    where: { id: runId },
    select: {
      status: true,
      startedAt: true,
      firstResponseAt: true,
      userId: true,
      leaseOwner: true,
      leaseFence: true,
    },
  });
  if (!run || (run.status === "cancelled" && !options?.allowCancelled)) {
    throw new RunHistoryWriteError();
  }
  if (
    lease &&
    (run.leaseFence !== lease.fence || (run.leaseOwner !== null && run.leaseOwner !== lease.owner))
  ) {
    throw new RunHistoryWriteError();
  }
  return run;
}

/**
 * run.cancelled is recorded by the path that cancelled the run, after the row
 * already reads cancelled — where the liveness assert above would reject it.
 * The event must name its run (clients key off it) and the row must already be
 * cancelled, so it can never announce a cancellation nothing committed.
 */
export async function assertRunIsCancelled(
  tx: Prisma.TransactionClient,
  runId?: string,
): Promise<void> {
  if (!runId) throw new RunHistoryWriteError();
  const run = await tx.run.findUnique({
    where: { id: runId },
    select: { status: true },
  });
  if (run?.status !== "cancelled") {
    throw new RunHistoryWriteError();
  }
}
