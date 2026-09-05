import type { MessageBlock } from "@rakazo/contracts";
import { messagingAudienceChannelId } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";

/** Group messaging history never includes the owner's private thread context. */
export function loadRunHistoryMessages(
  prisma: PrismaClient,
  run: { threadId: string; audience?: string | null },
  limit: number,
) {
  return prisma.message.findMany({
    where: {
      threadId: run.threadId,
      ...(messagingAudienceChannelId(run.audience) ? { audience: run.audience } : {}),
    },
    orderBy: { seq: "desc" },
    take: limit,
    select: { id: true, seq: true, role: true, runId: true, blocks: true },
  });
}

export interface CreateThreadMessageInput {
  threadId: string;
  role: "user" | "bot" | "system";
  blocks: MessageBlock[];
  botId?: string;
  replyToMessageId?: string;
  runId?: string;
  /** Set by trusted inbound routing; run output always inherits its run's audience. */
  audience?: string | null;
  clientNonce?: string;
  markUnread?: boolean;
}

export async function createThreadMessage(prisma: PrismaClient, input: CreateThreadMessageInput) {
  return prisma.$transaction((tx: Prisma.TransactionClient) =>
    createThreadMessageInTransaction(tx, input),
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
  const run = await assertRunCanWriteHistory(tx, input.runId);
  return tx.message.create({
    data: {
      threadId: input.threadId,
      seq: thread.nextMessageSeq - 1,
      role: input.role,
      blocks: input.blocks as Prisma.InputJsonValue,
      botId: input.botId,
      replyToMessageId: input.replyToMessageId,
      runId: input.runId,
      audience: run ? run.audience : input.audience,
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

export async function assertRunCanWriteHistory(
  tx: Prisma.TransactionClient,
  runId?: string,
): Promise<{ status: string; startedAt: Date | null; audience: string | null } | undefined> {
  if (!runId) return;
  const run = await tx.run.findUnique({
    where: { id: runId },
    select: { status: true, startedAt: true, audience: true },
  });
  if (!run || run.status === "cancelled") {
    throw new RunHistoryWriteError();
  }
  return run;
}
