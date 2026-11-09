import { ORPCError } from "@orpc/server";
import type { JobPublisher } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { canRetryRun, QUEUE_HOLDING_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  IsolationError,
  isUniqueViolation,
  SpaceDeletionInProgressError,
  spaceTakesWork,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import type { ThreadTarget } from "./thread-target.js";
import { enqueueRunsNeedingContinue, lockAndLoadGroupMembers } from "./thread-target.js";

const STALE_RETRY = "This reply can no longer be retried.";

/**
 * Run a failed reply again from the message that started it. Only its sender may, and only while
 * nothing newer was asked and the bot is free. A retry is made once: a repeat returns the same run.
 */
export async function retryThreadRun(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  actor: Actor,
  target: ThreadTarget,
  runId: string,
) {
  const existingRetry = () =>
    deps.prisma.run.findUnique({
      where: { retryOfRunId: runId },
      select: { id: true, threadId: true, userId: true },
    });
  const repeated = await existingRetry();
  if (repeated) return ownRetry(repeated, actor, target);
  let retry: { id: string; status: string };
  try {
    retry = await deps.prisma.$transaction(async (tx) => {
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
        throw new ORPCError("CONFLICT", { message: STALE_RETRY });
      }
      const [newerMessage, busyRun] = await Promise.all([
        tx.message.findFirst({
          where: { threadId: target.threadId, role: "user", seq: { gt: source.seq } },
          select: { id: true },
        }),
        tx.run.findFirst({
          where: {
            threadId: target.threadId,
            botId,
            status: { in: [...QUEUE_HOLDING_RUN_STATUSES] },
          },
          select: { id: true },
        }),
      ]);
      if (newerMessage || busyRun) throw new ORPCError("CONFLICT", { message: STALE_RETRY });
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
    }, THREAD_LOCK_TRANSACTION_OPTIONS);
  } catch (error) {
    // retryOfRunId is unique: a concurrent tap already queued this retry.
    const concurrent = isUniqueViolation(error) ? await existingRetry() : null;
    if (!concurrent) throw error;
    return ownRetry(concurrent, actor, target);
  }
  await enqueueRunsNeedingContinue(deps.jobs, [retry]);
  return { runId: retry.id };
}

function ownRetry(
  retry: { id: string; threadId: string; userId: string },
  actor: Actor,
  target: ThreadTarget,
) {
  if (retry.threadId !== target.threadId || retry.userId !== actor.userId) {
    throw new IsolationError();
  }
  return { runId: retry.id };
}
