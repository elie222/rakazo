import type {
  AdapterContext,
  ArtifactStore,
  JobPublisher,
  MediaGenerationProvider,
} from "@rakazo/adapter-kit";
import { mediaPollJob, runContinueJob } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { generateMediaFromTool, MEDIA_JOB_KIND } from "./media-generation-tools.js";
import { persistMessageInTransaction } from "./run-messages.js";
import { attachWorkspaceFileToThread } from "./thread-artifacts.js";

/** A short video takes minutes; one still unfinished after this is reported as failed. */
export const MEDIA_POLL_DEADLINE_MS = 60 * 60_000;
/** Recovery looks back past the deadline so a job lost just before it still gets reported. */
const RECOVERY_WINDOW_MS = MEDIA_POLL_DEADLINE_MS + 15 * 60_000;
/** A poll lock held this long belongs to a worker that died; a live poll finishes well within it. */
const ABANDONED_POLL_LOCK_MS = 10 * 60_000;
const PENDING_STATUSES = ["media_pending", "media_polling"];

export interface MediaVideoDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events: Pick<ThreadEvents, "notify">;
  artifacts?: ArtifactStore;
  maxUploadSizeBytes?: number;
  mediaGeneration?: MediaGenerationProvider;
}

type MediaRun = { id: string; threadId: string; botId: string; userId: string; spaceId: string };

/** Poll soon after submission, then less often as the job ages. */
export function nextMediaPollAt(createdAt: Date, now = Date.now()): Date {
  const delay = Math.min(5 * 60_000, Math.max(10_000, (now - createdAt.getTime()) / 5));
  return new Date(now + delay);
}

/** The job row is the outbox; a lost enqueue is recovered by reconcileMediaVideos. */
export async function scheduleMediaPoll(
  jobs: JobPublisher,
  jobId: string,
  createdAt = new Date(),
): Promise<void> {
  await jobs.enqueue(mediaPollJob(jobId, nextMediaPollAt(createdAt))).catch(() => {
    getLogger().warn("media poll deferred to reconciliation");
  });
}

/** Attach a finished video to the run's chat and post it, once, with the job's completion. */
export function mediaDelivery(
  deps: Pick<MediaVideoDeps, "prisma" | "events" | "maxUploadSizeBytes"> & {
    artifacts: ArtifactStore;
  },
  run: MediaRun,
  options: { providerId: string; groupId?: string; operationId: string },
) {
  return {
    attach: (
      output: { bytes: Uint8Array },
      fileName: string,
      job: { id: string; result: { provider: string; jobId?: string } },
    ) =>
      attachWorkspaceFileToThread(
        {
          prisma: deps.prisma,
          artifacts: deps.artifacts,
          maxUploadSizeBytes: deps.maxUploadSizeBytes,
        },
        {
          spaceId: run.spaceId,
          userId: run.userId,
          botId: run.botId,
          groupId: options.groupId,
          runId: run.id,
          filePath: fileName,
          bytes: output.bytes,
          operationId: options.operationId,
          onAttached: async (tx, artifact) => {
            const checkpointed = await tx.externalEffect.updateMany({
              where: {
                id: job.id,
                status: { not: "media_completed" },
                result: { equals: job.result },
              },
              data: {
                status: "media_polling",
                result: { ...job.result, artifactId: artifact.id },
              },
            });
            if (!checkpointed.count) throw new Error("Media attachment was already checkpointed");
          },
        },
      ),
    publish: async (
      block: Parameters<typeof persistMessageInTransaction>[3][number],
      jobId: string,
      artifactId: string,
    ) => {
      const committed = await deps.prisma.$transaction(async (tx) => {
        // Commit completion with the message so a restarted poll cannot post twice.
        const claimed = await tx.externalEffect.updateMany({
          where: { id: jobId, status: { not: "media_completed" } },
          data: {
            status: "media_completed",
            result: { provider: options.providerId, artifactId },
          },
        });
        if (!claimed.count) return null;
        return persistMessageInTransaction(tx, run, "bot", [block]);
      });
      if (committed)
        await deps.events
          .notify(run.threadId, committed.eventSeq, committed.firstResponseRunId)
          .catch(() => undefined);
    },
  };
}

/**
 * Check one submitted video for the chat that asked for it. A finished video is posted and a
 * failed or expired one is marked failed; either way the bot gets one turn to follow up.
 */
export async function pollMediaVideo(deps: MediaVideoDeps, payload: { jobId: string }) {
  const provider = deps.mediaGeneration;
  const artifacts = deps.artifacts;
  if (!provider?.capabilities.video || !artifacts) return;
  const job = await deps.prisma.externalEffect.findFirst({
    where: { id: payload.jobId, kind: MEDIA_JOB_KIND, status: { in: PENDING_STATUSES } },
    select: {
      id: true,
      createdAt: true,
      request: true,
      run: {
        select: {
          id: true,
          threadId: true,
          botId: true,
          userId: true,
          spaceId: true,
          status: true,
          thread: { select: { groupId: true, historyCompactionGeneration: true } },
        },
      },
    },
  });
  if (!job) return;
  const { thread, status: runStatus, ...run } = job.run;
  const request = job.request as { threadGeneration?: unknown };
  const [member, bot] = await Promise.all([
    deps.prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: run.spaceId, userId: run.userId } },
      select: { id: true },
    }),
    deps.prisma.bot.findFirst({
      where: { id: run.botId, spaceId: run.spaceId, userId: run.userId, archivedAt: null },
      select: { id: true },
    }),
  ]);
  // Nobody is left to tell once the bot or its owner is gone, the turn was stopped, or the
  // chat was cleared. Close the job so recovery stops picking it up.
  if (
    !member ||
    !bot ||
    runStatus === "cancelled" ||
    (typeof request.threadGeneration === "number" &&
      request.threadGeneration !== thread.historyCompactionGeneration)
  ) {
    await deps.prisma.externalEffect.updateMany({
      where: { id: job.id, status: "media_pending" },
      data: { status: "media_failed" },
    });
    return;
  }
  if (Date.now() - job.createdAt.getTime() >= MEDIA_POLL_DEADLINE_MS) {
    const expired = await deps.prisma.externalEffect.updateMany({
      where: {
        id: job.id,
        OR: [
          { status: "media_pending" },
          {
            status: "media_polling",
            updatedAt: { lt: new Date(Date.now() - ABANDONED_POLL_LOCK_MS) },
          },
        ],
      },
      data: { status: "media_failed" },
    });
    if (expired.count) await wakeBot(deps, job.id, run, thread.historyCompactionGeneration, false);
    else await scheduleMediaPoll(deps.jobs, job.id, job.createdAt);
    return;
  }
  const operationId = `media.poll:${job.id}`;
  const context: AdapterContext = {
    operationId,
    traceId: job.id,
    spaceId: run.spaceId,
    userId: run.userId,
    botId: run.botId,
    signal: AbortSignal.timeout(5 * 60_000),
  };
  const result = await generateMediaFromTool({
    name: "generate_video",
    args: { jobId: job.id },
    executionId: operationId,
    recoverOnly: true,
    provider,
    prisma: deps.prisma,
    context,
    run,
    ...mediaDelivery({ ...deps, artifacts }, run, {
      providerId: provider.id,
      groupId: thread.groupId ?? undefined,
      operationId,
    }),
  });
  if (result?.status === "completed" || result?.status === "failed") {
    await wakeBot(
      deps,
      job.id,
      run,
      thread.historyCompactionGeneration,
      result.status === "completed",
    );
    return;
  }
  // Still running, briefly locked by another check, or a provider error: try again later.
  await scheduleMediaPoll(deps.jobs, job.id, job.createdAt);
}

/** Give the bot one turn on the outcome, so it can follow up and the user is notified. */
async function wakeBot(
  deps: Pick<MediaVideoDeps, "prisma" | "jobs">,
  jobId: string,
  run: MediaRun,
  threadGeneration: number,
  completed: boolean,
) {
  const wakeRunId = await deps.prisma.$transaction(async (tx) => {
    // Same lock order as clearing chat: thread first, then the run it queues.
    const thread = await tx.thread.updateMany({
      where: {
        id: run.threadId,
        spaceId: run.spaceId,
        userId: run.userId,
        historyCompactionGeneration: threadGeneration,
      },
      data: { nextEventSeq: { increment: 0 } },
    });
    if (!thread.count) return null;
    const clientNonce = `media-wake:${jobId}`;
    const prior = await tx.run.findFirst({
      where: { spaceId: run.spaceId, clientNonce },
      select: { id: true },
    });
    if (prior) return null;
    const task = await tx.task.create({
      data: {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: run.threadId,
        userId: run.userId,
        prompt: completed
          ? `Video job ${jobId} finished and is attached to the chat.`
          : `Video job ${jobId} failed. Do not resubmit unless the user asks.`,
        status: "queued",
      },
    });
    const wake = await tx.run.create({
      data: {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: run.threadId,
        userId: run.userId,
        taskId: task.id,
        status: "queued",
        trigger: "media",
        clientNonce,
      },
    });
    return wake.id;
  });
  if (!wakeRunId) return;
  // The run reconciler recovers a queued wake after an enqueue failure.
  await deps.jobs.enqueue(runContinueJob(wakeRunId)).catch(() => {
    getLogger().warn("media wake deferred to reconciliation");
  });
}

/** Re-enqueue unfinished videos whose poll was lost, for example to a worker restart. */
export async function reconcileMediaVideos(
  deps: Pick<MediaVideoDeps, "prisma" | "jobs" | "mediaGeneration">,
) {
  if (!deps.mediaGeneration?.capabilities.video) return;
  const now = Date.now();
  const due = await deps.prisma.externalEffect.findMany({
    where: {
      kind: MEDIA_JOB_KIND,
      status: { in: PENDING_STATUSES },
      createdAt: { gt: new Date(now - RECOVERY_WINDOW_MS) },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 100,
    select: { id: true, createdAt: true },
  });
  await Promise.all(
    due.map((job) =>
      deps.jobs
        .enqueue({
          ...mediaPollJob(job.id, nextMediaPollAt(job.createdAt, now)),
          // A scheduled poll is left alone; only a missing, exhausted or abandoned one is replaced.
          keepExisting: true,
          replaceLockedBefore: new Date(now - ABANDONED_POLL_LOCK_MS),
        })
        .catch(() => getLogger().warn("media poll recovery deferred")),
    ),
  );
}
