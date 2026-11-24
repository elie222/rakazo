import type { JobPublisher } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, ClientError, canRetryRun } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  IsolationError,
  readJsonColumn,
  SpaceDeletionInProgressError,
  spaceTakesWork,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  touchGroupUpdatedAt,
  withTransactionRetry,
} from "@rakazo/db";
import * as z from "zod";
import type { ThreadTarget } from "./thread-target.js";
import { enqueueRunsNeedingContinue, lockAndLoadGroupMembers } from "./thread-target.js";

class StaleRetryError extends ClientError {
  constructor() {
    super("CONFLICT", "This reply can no longer be retried.");
  }
}

const failurePayload = z.object({ retryable: z.boolean().optional() });

export async function hasRetryableFailure(
  tx: Prisma.TransactionClient,
  threadId: string,
  runId: string,
): Promise<boolean> {
  const event = await tx.event.findFirst({
    where: { threadId, runId, type: "run.failed" },
    orderBy: { seq: "desc" },
    select: { id: true, payload: true },
  });
  if (!event) return false;
  const payload = readJsonColumn(
    failurePayload,
    event.payload,
    { table: "events", column: "payload", id: event.id },
    "reject",
  );
  return payload.retryable === true;
}

/**
 * Run a failed reply again from the message that started it. Only its sender may, and only while
 * nothing newer was asked and the bot is free, with no question waiting. A retry is made once: a
 * repeat returns the same run.
 */
export async function retryThreadRun(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  actor: Actor,
  target: ThreadTarget,
  runId: string,
) {
  const retry = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      if (!(await spaceTakesWork(tx, actor.spaceId))) throw new SpaceDeletionInProgressError();
      const members =
        target.kind === "group" ? await lockAndLoadGroupMembers(tx, actor, target) : undefined;
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
      // A concurrent request may have just queued this retry while we waited for the lock.
      const existing = await tx.run.findUnique({
        where: { retryOfRunId: runId },
        select: { id: true, status: true, threadId: true, userId: true, botId: true },
      });
      if (existing) {
        if (existing.threadId !== target.threadId || existing.userId !== actor.userId) {
          throw new IsolationError();
        }
        if (members && !members.some((member) => member.botId === existing.botId)) {
          throw new StaleRetryError();
        }
        return existing;
      }
      const failed = await tx.run.findFirst({
        where: { id: runId, spaceId: actor.spaceId, threadId: target.threadId },
        include: {
          task: { select: { prompt: true } },
          sourceMessage: { select: { id: true, seq: true, role: true, runId: true } },
        },
      });
      if (!failed) throw new IsolationError();
      const botId = failed.botId;
      const source = failed.sourceMessage;
      if (
        !canRetryRun(
          { ...failed, retryable: await hasRetryableFailure(tx, target.threadId, runId) },
          actor.userId,
        ) ||
        source?.role !== "user" ||
        (members && !members.some((member) => member.botId === botId))
      ) {
        throw new StaleRetryError();
      }
      const [newerMessage, busyRun] = await Promise.all([
        tx.message.findFirst({
          where: {
            threadId: target.threadId,
            role: "user",
            seq: { gt: source.seq },
          },
          select: { id: true },
        }),
        tx.run.findFirst({
          where: {
            threadId: target.threadId,
            botId,
            status: { in: [...ACTIVE_RUN_STATUSES] },
          },
          select: { id: true },
        }),
      ]);
      if (newerMessage || busyRun) throw new StaleRetryError();
      const task = await tx.task.create({
        data: {
          spaceId: actor.spaceId,
          botId,
          threadId: target.threadId,
          userId: actor.userId,
          prompt: failed.task.prompt,
          status: "queued",
        },
      });
      const run = await tx.run.create({
        data: {
          spaceId: actor.spaceId,
          botId,
          threadId: target.threadId,
          taskId: task.id,
          userId: actor.userId,
          status: "queued",
          trigger: failed.trigger,
          groupReplyOptional: failed.groupReplyOptional,
          sourceMessageId: source.id,
          retryOfRunId: failed.id,
          ...(failed.modelPinned
            ? {
                modelProvider: failed.modelProvider,
                modelId: failed.modelId,
                thinkingLevel: failed.thinkingLevel,
                modelPinned: true,
              }
            : {}),
        },
        select: { id: true, status: true },
      });
      if (source.runId === failed.id) {
        await tx.message.update({ where: { id: source.id }, data: { runId: run.id } });
      }
      if (target.kind === "group") await touchGroupUpdatedAt(tx, target.groupId);
      return run;
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
  // A repeat wakes the existing retry again, in case the first wake was lost.
  await enqueueRunsNeedingContinue(deps.jobs, [retry]);
  return { runId: retry.id };
}
