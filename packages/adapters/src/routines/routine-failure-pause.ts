import { isServerRunError, normalizeRunError } from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { RoutineRunRef } from "./routine-backoff.js";
import { routineGroupThreadId } from "./routine-thread.js";
import { postRoutineWatchMessage } from "./routine-watch.js";

/**
 * Failed runs in a row that pause a routine. A passing outage rarely fails more than a run or
 * two; five in a row is a fault the user has to fix, and an every-minute routine stops within
 * minutes instead of failing all day.
 */
export const ROUTINE_FAILURE_PAUSE_AFTER = 5;

type RoutineFailurePauseDeps = {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "notify" | "publishSpaceChange">;
};

/** The latest error when the owner's last runs of the active routine all failed alike, or null. */
async function failingStreak(
  client: Prisma.TransactionClient,
  run: RoutineRunRef,
): Promise<{
  name: string;
  error: string;
  routine: { threadId: string | null; spaceId: string };
} | null> {
  const routine = await client.routine.findUnique({
    where: { id: run.routineId },
    select: {
      active: true,
      userId: true,
      name: true,
      failurePausedAt: true,
      threadId: true,
      spaceId: true,
    },
  });
  if (!routine?.active || routine.userId !== run.userId) return null;
  const recent = await client.run.findMany({
    where: {
      routineId: run.routineId,
      userId: routine.userId,
      trigger: "routine",
      status: { in: ["completed", "failed"] },
      ...(routine.failurePausedAt ? { createdAt: { gt: routine.failurePausedAt } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: ROUTINE_FAILURE_PAUSE_AFTER,
    select: { status: true, error: true },
  });
  const error = recent[0]?.error;
  if (!error || isServerRunError(error) || recent.length < ROUTINE_FAILURE_PAUSE_AFTER) {
    return null;
  }
  // A different failure, such as an internal error the call site never counts, breaks it.
  const cause = failureCause(error);
  return recent.every(
    (row) => row.status === "failed" && row.error && failureCause(row.error) === cause,
  )
    ? { name: routine.name, error, routine }
    : null;
}

function failureCause(error: string): string {
  const { kind, summary } = normalizeRunError(error);
  return kind ?? summary;
}

/**
 * A run of the routine just failed for a reason the user has to fix. If the owner's last runs
 * all failed the same way, turn the routine off and say why in its chat. Cancelled runs are
 * skipped, and a success or any other failure breaks the streak.
 */
export async function pauseRoutineAfterRepeatedFailures(
  deps: RoutineFailurePauseDeps,
  run: RoutineRunRef & { spaceId: string; botId: string },
  now = new Date(),
): Promise<void> {
  const latest = await bestEffort("routine failure streak", failingStreak(deps.prisma, run));
  if (!latest) return;
  // Under the routine's lock, so overlapping failures pause it and post the message once.
  const paused = await bestEffort(
    "routine failure pause",
    deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM routines WHERE id = ${run.routineId} FOR UPDATE`;
      const streak = await failingStreak(tx, run);
      if (!streak) return null;
      await tx.routine.update({
        where: { id: run.routineId },
        data: { active: false, nextRunAt: null, failurePausedAt: now },
      });
      return streak;
    }),
  );
  if (!paused) return;
  await bestEffort(
    "routine failure pause change",
    deps.events.publishSpaceChange?.(run.spaceId, "routines"),
  );
  // The chat its next run would use, as a scheduled tick picks it.
  const threadId =
    (await routineGroupThreadId(deps.prisma, paused.routine, run.botId)) ??
    (
      await deps.prisma.bot.findUnique({
        where: { id: run.botId },
        select: { thread: { select: { id: true } } },
      })
    )?.thread?.id;
  if (!threadId) return;
  await postRoutineWatchMessage(deps, {
    spaceId: run.spaceId,
    threadId,
    botId: run.botId,
    role: "bot",
    text: `I paused the **${paused.name}** routine because its last ${ROUTINE_FAILURE_PAUSE_AFTER} runs failed: ${normalizeRunError(paused.error).summary}\n\nReply here and I'll help fix it.`,
  });
}
