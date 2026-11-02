import type { AdapterContext, NotificationMessage } from "@rakazo/adapter-kit";
import { ROUTINE_DELAY_GRACE_MS, routineScheduleDelay } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

type DelayState = {
  active: boolean;
  delayAlertsEnabled: boolean;
  nextRunAt: Date | null;
  delayAlertSchedule: Date | null;
  delayAlertClaimedAt: Date | null;
  delayAlertSentAt: Date | null;
  delayAlertResult: string | null;
};

const HOUR = 60 * 60_000;
const CLAIM_TTL = 2 * 60_000;

/** A future nextRunAt includes intentional provider backoff and is never overdue. */
export function shouldAlertDelayedRoutine(row: DelayState, now: Date): boolean {
  const time = now.getTime();
  if (
    !row.delayAlertsEnabled ||
    !row.nextRunAt ||
    !routineScheduleDelay(row.active, row.nextRunAt, now)
  )
    return false;
  if (row.delayAlertSchedule && row.delayAlertResult === "sent") return false;
  if (row.delayAlertSentAt && time - row.delayAlertSentAt.getTime() < HOUR) return false;
  if (row.delayAlertClaimedAt) {
    const wait = row.delayAlertResult === "pending" ? CLAIM_TTL : HOUR;
    if (time - row.delayAlertClaimedAt.getTime() < wait) return false;
  }
  return true;
}

type AlertRow = Pick<
  DelayState,
  | "nextRunAt"
  | "delayAlertSchedule"
  | "delayAlertClaimedAt"
  | "delayAlertSentAt"
  | "delayAlertResult"
> & {
  id: string;
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
  name: string;
};
type Deliver = (
  message: NotificationMessage,
  context: AdapterContext,
) => Promise<"delivered" | "undeliverable">;

export async function sendRoutineDelayAlert(
  prisma: PrismaClient,
  deliver: Deliver,
  row: AlertRow,
  now: Date,
): Promise<void> {
  if (!row.nextRunAt) return;
  const claimed = await prisma.routine.updateMany({
    where: {
      id: row.id,
      spaceId: row.spaceId,
      userId: row.userId,
      active: true,
      bot: { archivedAt: null },
      delayAlertsEnabled: true,
      nextRunAt: row.nextRunAt,
      delayAlertSchedule: row.delayAlertSchedule,
      delayAlertClaimedAt: row.delayAlertClaimedAt,
      delayAlertSentAt: row.delayAlertSentAt,
      delayAlertResult: row.delayAlertResult,
    },
    data: {
      delayAlertSchedule: row.nextRunAt,
      delayAlertClaimedAt: now,
      delayAlertResult: "pending",
    },
  });
  if (!claimed.count) return;
  const current = await prisma.routine.findFirst({
    where: {
      id: row.id,
      spaceId: row.spaceId,
      userId: row.userId,
      active: true,
      bot: { archivedAt: null },
      delayAlertsEnabled: true,
      nextRunAt: row.nextRunAt,
      delayAlertSchedule: row.nextRunAt,
      delayAlertClaimedAt: now,
      delayAlertResult: "pending",
    },
    select: { id: true },
  });
  if (!current) return;
  let result: "sent" | "failed" = "failed";
  try {
    const sent = await deliver(
      {
        kind: "failure",
        title: "Schedule delayed",
        body: row.name,
        botId: row.botId,
        threadId: row.threadId,
        routineId: row.id,
      },
      {
        operationId: "routine-delay-alert",
        traceId: row.id,
        spaceId: row.spaceId,
        userId: row.userId,
        botId: row.botId,
        signal: new AbortController().signal,
      },
    );
    if (sent === "delivered") result = "sent";
  } catch (error) {
    getLogger().error("routine delay alert", error);
  }
  await prisma.routine.updateMany({
    where: {
      id: row.id,
      delayAlertSchedule: row.nextRunAt,
      delayAlertClaimedAt: now,
      delayAlertResult: "pending",
    },
    data: { delayAlertResult: result, ...(result === "sent" ? { delayAlertSentAt: now } : {}) },
  });
}

/** Worker-local detection cannot report a complete worker outage. */
export function startRoutineDelayAlerts(
  prisma: PrismaClient,
  deliver: Deliver,
): () => Promise<void> {
  let stopping = false;
  let scanning = false;
  let scanWork: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  const scan = async () => {
    if (stopping || scanning) return;
    scanning = true;
    try {
      let cursor: string | undefined;
      const now = new Date();
      await clearRecoveredRoutineDelayAlerts(prisma, now);
      do {
        const rows = await prisma.routine.findMany({
          where: {
            active: true,
            delayAlertsEnabled: true,
            nextRunAt: { lt: new Date(now.getTime() - ROUTINE_DELAY_GRACE_MS) },
            bot: { archivedAt: null },
          },
          orderBy: { id: "asc" },
          take: 100,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          include: { bot: { select: { thread: { select: { id: true } } } } },
        });
        for (const row of rows) {
          const threadId = row.threadId ?? row.bot.thread?.id;
          if (!threadId || !shouldAlertDelayedRoutine(row, now)) continue;
          const work = sendRoutineDelayAlert(prisma, deliver, { ...row, threadId }, now).catch(
            (error) => getLogger().error("routine delay scan", error),
          );
          pending.add(work);
          void work.finally(() => pending.delete(work));
        }
        cursor = rows.length === 100 ? rows.at(-1)?.id : undefined;
      } while (cursor && !stopping);
    } finally {
      scanning = false;
    }
  };
  const tick = () => {
    if (scanWork) return;
    scanWork = scan()
      .catch((error) => getLogger().error("routine delay scan", error))
      .finally(() => {
        scanWork = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, 30_000);
  return async () => {
    stopping = true;
    clearInterval(timer);
    await scanWork;
    await Promise.allSettled([...pending]);
  };
}

export async function clearRecoveredRoutineDelayAlerts(
  prisma: PrismaClient,
  now: Date,
): Promise<void> {
  await prisma.routine.updateMany({
    where: {
      delayAlertSchedule: { not: null },
      OR: [
        { active: false },
        { delayAlertsEnabled: false },
        { nextRunAt: null },
        { nextRunAt: { gte: new Date(now.getTime() - ROUTINE_DELAY_GRACE_MS) } },
      ],
    },
    data: { delayAlertSchedule: null, delayAlertClaimedAt: null, delayAlertResult: null },
  });
}
