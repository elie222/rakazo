import { QUEUE_HOLDING_RUN_STATUSES } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import { HOLDS_CHAT, handQueuedRunToWorkingRun } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import { dueRoutineHandoverPrompt } from "../../routines/routine-conversation.prompt.js";
import { ROUTINE_WATCH_NOTE_START } from "../../routines/routine-watch.prompt.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { wakeRun } from "../wakeups/wake-run.js";

/** How long a run waits for its busy chat before it looks again, or a scheduled task hands over. */
export const CHAT_WAIT_MS = 5 * 60_000;

const CHAT_WAITING_TRIGGERS: readonly string[] = ["routine", "bot_message"];

/** A turn the bot takes with no message of its own, such as carrying on once the user connects
 * an app from its card, waits for a busy chat as well, so it reads what that run did. */
function waitsForChat(run: { trigger: string; sourceMessageId: string | null }): boolean {
  return (
    CHAT_WAITING_TRIGGERS.includes(run.trigger) ||
    (run.trigger === "user" && run.sourceMessageId === null)
  );
}

interface ChatWaitingRun {
  id: string;
  botId: string;
  threadId: string;
  taskId: string;
  trigger: string;
  sourceMessageId: string | null;
  status: string;
  startedAt: Date | null;
  wakeAt: Date | null;
  createdAt: Date;
  routine: { name: string; inChat: boolean } | null;
}

/**
 * A scheduled task or a message from another bot never starts beside another run in its chat, so
 * their messages never mix and it reads what that run did instead of doing the same work at the
 * same time: its claim waits for that run to end. Holds until then; after a while a scheduled task
 * hands itself to that run instead, so a run that goes on for hours does not hold it back. A
 * routine that runs alongside its chat starts on time. A check-in belongs to no routine and runs
 * in the chat.
 */
export function claimWaitsForChat(
  run: Pick<
    ChatWaitingRun,
    "id" | "botId" | "trigger" | "sourceMessageId" | "startedAt" | "createdAt"
  >,
  now: Date,
): Prisma.RunWhereInput {
  if (!waitsForChat(run) || run.startedAt) return {};
  const chatFree: Prisma.RunWhereInput = { thread: { runs: { none: busyRunWhere(run, now) } } };
  if (run.trigger !== "routine") return chatFree;
  return { OR: [{ routine: { is: { inChat: false } } }, chatFree] };
}

/** Another run in the chat is under way, or queued ahead of this one and due. */
function busyRunWhere(
  run: Pick<ChatWaitingRun, "id" | "botId" | "createdAt">,
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

/**
 * After a refused claim: hold a run its chat keeps busy. A scheduled task hands itself to the
 * working run once its wait is over. A message from another bot keeps waiting for a turn of its
 * own, because its reply goes back to that bot.
 */
export async function holdRunForChat(deps: ExecutorDeps, run: ChatWaitingRun): Promise<void> {
  if (!waitsForChat(run) || run.status !== "queued" || run.startedAt) return;
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
  const waitEnds = new Date(run.createdAt.getTime() + CHAT_WAIT_MS);
  if (run.trigger === "routine" && now >= waitEnds) {
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
  // The run ending first starts this one sooner; see startRunsWaitingOnChat.
  await wakeRun(deps.jobs, run.id, {
    at: now < waitEnds ? waitEnds : new Date(now.getTime() + CHAT_WAIT_MS),
  });
  // A run that ended before the wake time was saved found nothing to start.
  if (!(await chatBusy())) await wakeRun(deps.jobs, run.id);
}

/** A run stopped working on its chat: runs waiting on it may start now. */
export async function startRunsWaitingOnChat(
  deps: ExecutorDeps,
  run: { id: string; botId: string; threadId: string },
): Promise<void> {
  const waiting = await deps.prisma.run.findMany({
    where: {
      id: { not: run.id },
      threadId: run.threadId,
      botId: run.botId,
      AND: [
        {
          OR: [
            { trigger: { in: [...CHAT_WAITING_TRIGGERS] } },
            { trigger: "user", sourceMessageId: null },
          ],
        },
        { OR: [{ routineId: null }, { routine: { is: { inChat: true } } }] },
      ],
      status: "queued",
      startedAt: null,
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
