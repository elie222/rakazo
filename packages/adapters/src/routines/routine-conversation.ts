import { QUEUE_HOLDING_RUN_STATUSES } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import { HOLDS_CHAT, handQueuedRunToWorkingRun } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";
import { wakeRun } from "../runs/wakeups/wake-run.js";
import { dueRoutineHandoverPrompt } from "./routine-conversation.prompt.js";
import { ROUTINE_WATCH_NOTE_START } from "./routine-watch.prompt.js";

/** How long a scheduled run waits for its chat's current run before handing its task to that run. */
export const ROUTINE_CONVERSATION_WAIT_MS = 5 * 60_000;

interface RoutineRun {
  id: string;
  botId: string;
  threadId: string;
  taskId: string;
  trigger: string;
  status: string;
  startedAt: Date | null;
  wakeAt: Date | null;
  createdAt: Date;
  routine: { name: string; inChat: boolean } | null;
}

/**
 * A routine that runs in its chat never starts beside another run there, so their messages never
 * mix: its claim waits for that run to end. Holds until then; after a while it hands its task to
 * that run instead, so a run that goes on for hours does not hold it back. A routine that runs
 * alongside its chat starts on time. A check-in belongs to no routine and runs in the chat.
 */
export function routineClaimWaitsForConversation(
  run: Pick<RoutineRun, "id" | "botId" | "trigger" | "startedAt" | "createdAt">,
  now: Date,
): Prisma.RunWhereInput {
  if (run.trigger !== "routine" || run.startedAt) return {};
  return {
    OR: [
      { routine: { is: { inChat: false } } },
      { thread: { runs: { none: busyRunWhere(run, now) } } },
    ],
  };
}

/** Another run in the chat is under way, or queued ahead of this one and due. */
function busyRunWhere(
  run: Pick<RoutineRun, "id" | "botId" | "createdAt">,
  now: Date,
): Prisma.RunWhereInput {
  return {
    id: { not: run.id },
    botId: run.botId,
    status: { in: [...QUEUE_HOLDING_RUN_STATUSES] },
    ...HOLDS_CHAT,
    OR: [
      { startedAt: { not: null } },
      { status: { not: "queued" } },
      {
        OR: [
          { createdAt: { lt: run.createdAt } },
          { createdAt: run.createdAt, id: { lt: run.id } },
        ],
        AND: [{ OR: [{ wakeAt: null }, { wakeAt: { lte: now } }] }],
      },
    ],
  };
}

/** After a refused claim: hold a scheduled run its chat keeps busy, or hand it over once its wait is over. */
export async function holdRoutineRunForConversation(
  deps: ExecutorDeps,
  run: RoutineRun,
): Promise<void> {
  if (run.trigger !== "routine" || run.status !== "queued" || run.startedAt) return;
  // Read again: the claim saw the routine as it is now, which an edit may have changed since the
  // run was loaded.
  const current = await deps.prisma.run.findUnique({
    where: { id: run.id },
    select: { routine: { select: { inChat: true } } },
  });
  if (current?.routine && !current.routine.inChat) return;
  const now = new Date();
  // Not due yet: its wake comes back here.
  if (run.wakeAt && run.wakeAt > now) return;
  const chatBusy = async () =>
    (await deps.prisma.run.findFirst({
      where: { threadId: run.threadId, ...busyRunWhere(run, new Date()) },
      select: { id: true },
    })) !== null;
  if (!(await chatBusy())) return;
  const waitEnds = new Date(run.createdAt.getTime() + ROUTINE_CONVERSATION_WAIT_MS);
  if (now >= waitEnds) {
    const task = await deps.prisma.task.findUnique({
      where: { id: run.taskId },
      select: { prompt: true },
    });
    // A task queued while its routine watched still quotes what the watch read, even once the
    // routine stops watching.
    const handed =
      task && !task.prompt.includes(ROUTINE_WATCH_NOTE_START)
        ? await handQueuedRunToWorkingRun(deps.prisma, {
            runId: run.id,
            text: dueRoutineHandoverPrompt(run.routine?.name ?? null, task.prompt),
          })
        : null;
    if (handed) {
      getLogger().info("routine.handed_to_working_run", {
        "run.id": run.id,
        "run.working_id": handed.workingRunId,
      });
      await bestEffort("notify routine handover", deps.events.notify(handed.threadId, handed.seq));
      if (deps.events.publishSpaceChange)
        await bestEffort(
          "publish routine handover",
          deps.events.publishSpaceChange(handed.spaceId, "runs"),
        );
      return;
    }
  }
  // The run ending first starts this one sooner; see startRoutineRunsWaitingOn.
  await wakeRun(deps.jobs, run.id, {
    at: now < waitEnds ? waitEnds : new Date(now.getTime() + ROUTINE_CONVERSATION_WAIT_MS),
  });
  // A run that ended before the wake time was saved found nothing to start.
  if (!(await chatBusy())) await wakeRun(deps.jobs, run.id);
}

/** A run stopped working on its chat: scheduled runs waiting on it may start now. */
export async function startRoutineRunsWaitingOn(
  deps: ExecutorDeps,
  run: { id: string; botId: string; threadId: string },
): Promise<void> {
  const waiting = await deps.prisma.run.findMany({
    where: {
      id: { not: run.id },
      threadId: run.threadId,
      botId: run.botId,
      trigger: "routine",
      status: "queued",
      startedAt: null,
      OR: [{ routineId: null }, { routine: { is: { inChat: true } } }],
      // A retry, or a run backing off after a failed attempt, keeps its own delay.
      retryOfRunId: null,
      attempts: { none: {} },
      wakeAt: { gt: new Date() },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  for (const { id } of waiting) await wakeRun(deps.jobs, id);
}
