import type { JobPublisher } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, ClientError, canRetryRun } from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  IsolationError,
  readJsonColumn,
  SpaceDeletionInProgressError,
  spaceTakesWork,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  touchGroupUpdatedAt,
  withTransactionRetry,
} from "@rakazo/db";
import * as z from "zod";
import { assertTeachingSendAllowed } from "../bots/taught-skills.js";
import type { ThreadTarget } from "./thread-target.js";
import { enqueueRunsNeedingContinue, lockAndLoadGroupMembers } from "./thread-target.js";

class StaleRetryError extends ClientError {
  constructor() {
    super("CONFLICT", "This reply can no longer be retried.");
  }
}

const failurePayload = z.object({ retryable: z.boolean().optional() });

async function hasRetryableFailure(
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

/** The source can be retried only while this is still the sender's latest request and the bot is free. */
export async function findRetryableReplySource(
  tx: Prisma.TransactionClient,
  run: {
    id: string;
    threadId: string;
    botId: string;
    userId: string;
    status: string;
    trigger: string;
    sourceMessageId: string | null;
  },
  viewerId: string | undefined,
) {
  const { sourceMessageId, threadId, botId } = run;
  if (
    !sourceMessageId ||
    run.userId !== viewerId ||
    run.status !== "failed" ||
    !canRetryRun({ ...run, retryable: await hasRetryableFailure(tx, threadId, run.id) }, viewerId)
  ) {
    return null;
  }
  const source = await tx.message.findFirst({
    where: { id: sourceMessageId, threadId, role: "user", authorUserId: viewerId },
    select: { id: true, seq: true, runId: true },
  });
  if (!source) return null;
  const [newerMessage, busyRun] = await Promise.all([
    tx.message.findFirst({
      where: { threadId, role: "user", seq: { gt: source.seq } },
      select: { id: true },
    }),
    tx.run.findFirst({
      where: { threadId, botId, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true },
    }),
  ]);
  return newerMessage || busyRun ? null : source;
}

/**
 * Run a failed reply again from the message that started it. Only its sender may, and only while
 * nothing newer was asked and the bot is free, with no question waiting. A retry is made once: a
 * repeat returns the same run.
 */
export async function retryThreadRun(
  deps: { prisma: PrismaClient; jobs: JobPublisher; events: ThreadEvents },
  actor: Actor,
  target: ThreadTarget,
  runId: string,
) {
  const { run: retry, seq } = await withTransactionRetry(() =>
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
        if (
          existing.status === "cancelled" ||
          (members && !members.some((member) => member.botId === existing.botId))
        ) {
          throw new StaleRetryError();
        }
        return { run: existing, seq: null };
      }
      const failed = await tx.run.findFirst({
        where: { id: runId, spaceId: actor.spaceId, threadId: target.threadId },
        include: {
          task: { select: { prompt: true } },
        },
      });
      if (!failed) throw new IsolationError();
      const botId = failed.botId;
      if (members && !members.some((member) => member.botId === botId)) {
        throw new StaleRetryError();
      }
      const source = await findRetryableReplySource(tx, failed, actor.userId);
      if (!source) throw new StaleRetryError();
      if (target.kind === "bot") {
        await assertTeachingSendAllowed(tx, actor.spaceId, botId);
      }
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
      const event = await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: target.threadId,
        botId,
        runId: run.id,
        type: "thread.meta",
        payload: { retryQueued: true },
      });
      return { run, seq: event.seq };
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
  // A repeat wakes the existing retry again, in case the first wake was lost.
  await Promise.all([
    enqueueRunsNeedingContinue(deps.jobs, [retry]),
    ...(seq === null
      ? []
      : [
          deps.events.notify(target.threadId, seq),
          deps.events.publishSpaceChange?.(actor.spaceId, "runs"),
        ]),
  ]);
  return { runId: retry.id };
}
