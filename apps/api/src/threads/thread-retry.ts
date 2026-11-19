import type { JobPublisher } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, ClientError, canRetryRun } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  IsolationError,
  isUniqueViolation,
  SpaceDeletionInProgressError,
  spaceTakesWork,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withTransactionRetry,
} from "@rakazo/db";
import type { ThreadTarget } from "./thread-target.js";
import { enqueueRunsNeedingContinue, lockAndLoadGroupMembers } from "./thread-target.js";

class StaleRetryError extends ClientError {
  constructor() {
    super("CONFLICT", "This reply can no longer be retried.");
  }
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
  const existingRetry = async () => {
    const existing = await deps.prisma.run.findUnique({
      where: { retryOfRunId: runId },
      select: { id: true, status: true, threadId: true, userId: true },
    });
    if (existing && (existing.threadId !== target.threadId || existing.userId !== actor.userId)) {
      throw new IsolationError();
    }
    return existing;
  };
  // A repeat wakes the existing retry again, in case the first wake was lost.
  const retry = (await existingRetry()) ?? (await createRetry());
  await enqueueRunsNeedingContinue(deps.jobs, [retry]);
  return { runId: retry.id };

  async function createRetry() {
    try {
      return await withTransactionRetry(() =>
        deps.prisma.$transaction(async (tx) => {
          if (!(await spaceTakesWork(tx, actor.spaceId))) throw new SpaceDeletionInProgressError();
          const members =
            target.kind === "group" ? await lockAndLoadGroupMembers(tx, actor, target) : undefined;
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
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
            !canRetryRun(failed, actor.userId) ||
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
                // A follow-up or answer sent during the failed reply belongs to it.
                OR: [{ runId: null }, { runId: { not: failed.id } }],
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
          return run;
        }, THREAD_LOCK_TRANSACTION_OPTIONS),
      );
    } catch (error) {
      // retryOfRunId is unique: a concurrent tap already queued this retry.
      const concurrent = isUniqueViolation(error) ? await existingRetry() : null;
      if (!concurrent) throw error;
      return concurrent;
    }
  }
}
