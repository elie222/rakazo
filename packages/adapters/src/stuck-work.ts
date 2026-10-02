import type { JobPublisher, NotificationMessage, NotificationProvider } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { StuckWorkStatus } from "@rakazo/core";
import {
  isStuckWorkStatus,
  STUCK_WORK_NOTICE,
  STUCK_WORK_NOTIFY_AFTER_MS,
  STUCK_WORK_STATUSES,
  stuckWorkAction,
  stuckWorkAgeMs,
  stuckWorkReminder,
  stuckWorkStoppedNotification,
} from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import { appendEventInTransaction, expireStuckRun, withTransactionRetry } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { ExpoPushProvider } from "./expo-push.js";

type StuckCursor = { at: Date; id: string };

type StuckCandidate = {
  id: string;
  status: StuckWorkStatus;
  updatedAt: Date;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  taskId: string;
  bot: { name: string; notifyOnFinish: boolean };
  thread: { groupId: string | null };
};

/**
 * Remind, then cancel, queued runs and human waits that have been sitting still.
 * Lives on the job reconciler so a second scheduler is not required. The notice
 * stamp is a thread.meta event keyed to this episode's updatedAt, so answering
 * or reclaiming the run (which bumps updatedAt) can remind again later. It is
 * claimed before the push and removed when that push is not delivered, so a
 * failed push can retry and a successful one is not sent again.
 */
export async function reconcileStuckWork(deps: {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events?: ThreadEvents;
  notifications?: NotificationProvider;
  now: Date;
  batchSize: number;
  cursor?: StuckCursor;
}): Promise<StuckCursor | undefined> {
  const cutoff = new Date(deps.now.getTime() - STUCK_WORK_NOTIFY_AFTER_MS);
  const cursorFilter = deps.cursor
    ? {
        OR: [
          { updatedAt: { gt: deps.cursor.at } },
          { updatedAt: deps.cursor.at, id: { gt: deps.cursor.id } },
        ],
      }
    : undefined;
  const runs = await deps.prisma.run.findMany({
    where: {
      status: { in: [...STUCK_WORK_STATUSES] },
      AND: [{ updatedAt: { lte: cutoff } }, ...(cursorFilter ? [cursorFilter] : [])],
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: deps.batchSize,
    select: {
      id: true,
      status: true,
      updatedAt: true,
      spaceId: true,
      threadId: true,
      botId: true,
      userId: true,
      taskId: true,
      bot: { select: { name: true, notifyOnFinish: true } },
      thread: { select: { groupId: true } },
    },
  });

  const due = runs.flatMap((run) => {
    const candidate = readyStuckRun(run, deps.now);
    return candidate ? [candidate] : [];
  });
  const notices = due.length
    ? await deps.prisma.event.findMany({
        where: {
          runId: { in: due.map((run) => run.id) },
          type: "thread.meta",
          payload: { path: ["notice"], equals: STUCK_WORK_NOTICE },
        },
        select: { runId: true, payload: true },
      })
    : [];

  for (const run of due) {
    const alreadyNotified = notices.some(
      (notice) => notice.runId === run.id && noticeMatchesEpisode(notice.payload, run.updatedAt),
    );
    const action = stuckWorkAction({
      ageMs: stuckWorkAgeMs(run.updatedAt, deps.now),
      alreadyNotified,
    });
    try {
      if (action === "notify") await remindStuckRun(deps, run);
      else if (action === "expire") await expireOne(deps, run);
    } catch (error) {
      getLogger().error("stuck work", error);
    }
  }

  const last = runs.at(-1);
  if (runs.length < deps.batchSize || !last || !(last.updatedAt instanceof Date)) return undefined;
  return { at: last.updatedAt, id: last.id };
}

function readyStuckRun(
  run: Omit<Partial<StuckCandidate>, "status"> & { id: string; status?: string },
  now: Date,
): StuckCandidate | null {
  if (!run.status || !isStuckWorkStatus(run.status)) return null;
  if (!(run.updatedAt instanceof Date)) return null;
  if (stuckWorkAgeMs(run.updatedAt, now) < STUCK_WORK_NOTIFY_AFTER_MS) return null;
  if (!run.spaceId || !run.threadId || !run.botId || !run.userId || !run.taskId) return null;
  if (!run.bot || !run.thread) return null;
  return {
    id: run.id,
    status: run.status,
    updatedAt: run.updatedAt,
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    userId: run.userId,
    taskId: run.taskId,
    bot: run.bot,
    thread: run.thread,
  };
}

function noticesEnabled(run: StuckCandidate): boolean {
  return Boolean(run.thread.groupId || run.bot.notifyOnFinish);
}

function noticeMatchesEpisode(payload: unknown, updatedAt: Date): boolean {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as { notice?: unknown; updatedAt?: unknown };
  return record.notice === STUCK_WORK_NOTICE && record.updatedAt === updatedAt.toISOString();
}

async function remindStuckRun(
  deps: {
    prisma: PrismaClient;
    notifications?: NotificationProvider;
  },
  run: StuckCandidate,
) {
  // A skipped push (notices off, no provider, or no push token yet) stays unmarked
  // so a later sweep can still remind during this same wait.
  if (!deps.notifications || !noticesEnabled(run)) return;
  if (!(await pushCanDeliver(deps.notifications, run.userId))) return;
  const claimed = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      if (!(await stuckEpisodeOpen(tx, run))) return false;
      await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        type: "thread.meta",
        runId: run.id,
        payload: { notice: STUCK_WORK_NOTICE, updatedAt: run.updatedAt.toISOString() },
      });
      return true;
    }),
  );
  if (!claimed) return;
  const reminder = stuckWorkReminder(run.status, run.bot.name);
  const sent = await sendStuckNotice(deps.notifications, run, {
    kind: reminder.kind,
    title: reminder.title,
    body: reminder.body,
    botId: run.botId,
    threadId: run.threadId,
  });
  if (sent) return;
  await withTransactionRetry(() => deps.prisma.$transaction((tx) => clearStuckNotice(tx, run)));
}

async function pushCanDeliver(
  notifications: NotificationProvider,
  userId: string,
): Promise<boolean> {
  if (!(notifications instanceof ExpoPushProvider)) return true;
  return notifications.hasPushRecipient(userId);
}

async function clearStuckNotice(tx: Prisma.TransactionClient, run: StuckCandidate) {
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
  await tx.event.deleteMany({
    where: {
      runId: run.id,
      type: "thread.meta",
      AND: [
        { payload: { path: ["notice"], equals: STUCK_WORK_NOTICE } },
        { payload: { path: ["updatedAt"], equals: run.updatedAt.toISOString() } },
      ],
    },
  });
}

async function stuckEpisodeOpen(
  tx: Prisma.TransactionClient,
  run: StuckCandidate,
): Promise<boolean> {
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
  const current = await tx.run.findUnique({
    where: { id: run.id },
    select: { status: true, updatedAt: true },
  });
  if (
    !current ||
    current.status !== run.status ||
    current.updatedAt.getTime() !== run.updatedAt.getTime()
  ) {
    return false;
  }
  const existing = await tx.event.findFirst({
    where: {
      runId: run.id,
      type: "thread.meta",
      payload: { path: ["notice"], equals: STUCK_WORK_NOTICE },
    },
    orderBy: { seq: "desc" },
    select: { payload: true },
  });
  return !noticeMatchesEpisode(existing?.payload, current.updatedAt);
}

async function expireOne(
  deps: {
    prisma: PrismaClient;
    jobs: JobPublisher;
    events?: ThreadEvents;
    notifications?: NotificationProvider;
    now: Date;
  },
  run: StuckCandidate,
) {
  const expired = await withTransactionRetry(() =>
    deps.prisma.$transaction((tx) =>
      expireStuckRun(tx, {
        runId: run.id,
        threadId: run.threadId,
        status: run.status,
        updatedAt: run.updatedAt,
        now: deps.now,
      }),
    ),
  );
  if (!expired) return;
  await deps.events?.notify(run.threadId, expired.seq).catch((error) => {
    getLogger().error("stuck work realtime notification", error);
  });
  if (expired.continuationRunId) {
    await deps.jobs.enqueue(runContinueJob(expired.continuationRunId)).catch((error) => {
      getLogger().error("stuck work continuation", error);
    });
  }
  if (!deps.notifications || !noticesEnabled(run)) return;
  const stopped = stuckWorkStoppedNotification(run.status, run.bot.name);
  await sendStuckNotice(deps.notifications, run, {
    kind: stopped.kind,
    title: stopped.title,
    body: stopped.body,
    botId: run.botId,
    threadId: run.threadId,
  });
}

async function sendStuckNotice(
  notifications: NotificationProvider,
  run: StuckCandidate,
  message: NotificationMessage,
): Promise<boolean> {
  try {
    await notifications.send(message, {
      operationId: "notify",
      traceId: run.botId,
      spaceId: run.spaceId,
      userId: run.userId,
      botId: run.botId,
      signal: new AbortController().signal,
    });
    return true;
  } catch (error) {
    getLogger().error("stuck work notification", error);
    return false;
  }
}
