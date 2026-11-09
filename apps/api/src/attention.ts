import type { Actor, AttentionItem, MessageBlock } from "@rakazo/contracts";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import {
  attentionActionsForBlock,
  attentionKindForBlock,
  BACKGROUND_RUN_TRIGGERS,
  routineScheduleDelayed,
  sortAttentionItems,
  truncatePlainText,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { activityPreview } from "./runs.js";

const FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_WAITING_RUNS = 50;
const MAX_FAILED_RUNS = 20;
const MAX_ROUTINES = 50;
const MAX_DETAIL = 280;
/** How far back from a waiting run's last message a pending card can sit. */
const MESSAGES_PER_RUN = 8;

type WaitingRun = {
  id: string;
  botId: string;
  threadId: string;
  status: string;
  trigger: string;
  updatedAt: Date;
  bot: { name: string };
  task: { prompt: string };
  thread: { groupId: string | null; group: { name: string } | null };
};

type FailedRun = Omit<WaitingRun, "status" | "updatedAt"> & {
  status: string;
  completedAt: Date | null;
  updatedAt: Date;
};

type RoutineThread = {
  id: string;
  botId: string | null;
  groupId: string | null;
  group: { name: string; archivedAt: Date | null; members: { botId: string | null }[] } | null;
};

type RoutineRow = {
  id: string;
  botId: string;
  name: string;
  nextRunAt: Date | null;
  thread: RoutineThread | null;
  bot: { name: string; thread: RoutineThread | null };
};

/** The thread a routine runs in, matching dispatch: its own target when valid, else the bot's. */
function routineThread(routine: RoutineRow): RoutineThread | null {
  const candidate = routine.thread;
  if (
    candidate &&
    (candidate.botId === routine.botId ||
      (candidate.group &&
        !candidate.group.archivedAt &&
        candidate.group.members.some((member) => member.botId === routine.botId)))
  ) {
    return candidate;
  }
  return routine.bot.thread;
}

function detailText(value: string | undefined): string {
  return truncatePlainText(value?.replace(/\s+/g, " ").trim() ?? "", MAX_DETAIL);
}

function runItem(
  run: Pick<WaitingRun, "id" | "botId" | "threadId" | "trigger" | "bot" | "task" | "thread">,
  input: {
    kind: AttentionItem["kind"];
    detail: string;
    createdAt: Date;
    messageId?: string;
    actions?: AttentionItem["actions"];
  },
): AttentionItem {
  return {
    id: `run:${run.id}`,
    kind: input.kind,
    botId: run.botId,
    botName: run.bot.name,
    groupId: run.thread.groupId,
    groupName: run.thread.group?.name ?? null,
    threadId: run.threadId,
    runId: run.id,
    routineId: null,
    messageId: input.messageId ?? null,
    detail: detailText(input.detail),
    createdAt: input.createdAt.toISOString(),
    actions: input.actions ?? [],
  };
}

/**
 * Projects what already waits on a person into one queue. Read-only: the cards and runs keep
 * their existing source of truth, and answering still goes through `threads.answer`.
 */
export async function listAttentionItems(
  prisma: PrismaClient,
  actor: Actor,
  now = new Date(),
): Promise<AttentionItem[]> {
  const [waitingRuns, failedRuns, routines] = await Promise.all([
    prisma.run.findMany({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        bot: { archivedAt: null },
        // A background run that waits on a person is conversation, whatever started it.
        status: { in: ["waiting_input", "waiting_takeover"] },
        thread: { OR: [{ groupId: null }, { group: { archivedAt: null } }] },
      },
      select: {
        id: true,
        botId: true,
        threadId: true,
        status: true,
        trigger: true,
        updatedAt: true,
        bot: { select: { name: true } },
        task: { select: { prompt: true } },
        thread: {
          select: { groupId: true, group: { select: { name: true } } },
        },
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: MAX_WAITING_RUNS,
    }),
    prisma.run.findMany({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        bot: { archivedAt: null },
        trigger: { notIn: ["bot_message", ...BACKGROUND_RUN_TRIGGERS] },
        status: { in: ["failed", "completed", "cancelled"] },
        completedAt: { gte: new Date(now.getTime() - FAILED_WINDOW_MS) },
        thread: {
          reads: { some: { userId: actor.userId, spaceId: actor.spaceId, unread: true } },
          OR: [{ groupId: null }, { group: { archivedAt: null } }],
        },
      },
      select: {
        id: true,
        botId: true,
        threadId: true,
        status: true,
        trigger: true,
        completedAt: true,
        updatedAt: true,
        bot: { select: { name: true } },
        task: { select: { prompt: true } },
        thread: {
          select: { groupId: true, group: { select: { name: true } } },
        },
      },
      // The newest terminal run owns the chat's failure state; an older failure that a
      // successful retry superseded must not reappear while the chat stays unread.
      orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      distinct: ["threadId"],
      take: MAX_FAILED_RUNS,
    }),
    prisma.routine.findMany({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        active: true,
        notify: true,
        nextRunAt: { not: null },
        bot: { archivedAt: null },
      },
      select: {
        id: true,
        botId: true,
        name: true,
        nextRunAt: true,
        thread: {
          select: {
            id: true,
            botId: true,
            groupId: true,
            group: {
              select: {
                name: true,
                archivedAt: true,
                members: { select: { botId: true } },
              },
            },
          },
        },
        bot: {
          select: {
            name: true,
            thread: {
              select: {
                id: true,
                botId: true,
                groupId: true,
                group: {
                  select: {
                    name: true,
                    archivedAt: true,
                    members: { select: { botId: true } },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
      take: MAX_ROUTINES,
    }),
  ]);

  // One window query picks the newest messages per run, then the model read decrypts their
  // blocks. A query per run would fan out on every poll; a raw read alone skips decryption.
  const recentMessageIds = waitingRuns.length
    ? await prisma.$queryRaw<{ id: string }[]>`
        SELECT id
        FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY "runId" ORDER BY seq DESC) AS rn
          FROM messages
          WHERE "runId" IN (${Prisma.join(waitingRuns.map((run) => run.id))})
        ) ranked
        WHERE rn <= ${MESSAGES_PER_RUN}
      `
    : [];
  const messages = recentMessageIds.length
    ? await prisma.message.findMany({
        where: { id: { in: recentMessageIds.map((row) => row.id) } },
        select: { id: true, runId: true, blocks: true },
        orderBy: [{ runId: "asc" }, { seq: "desc" }],
      })
    : [];
  const pendingCardByRun = new Map<string, { messageId: string; block: MessageBlock }>();
  for (const message of messages) {
    if (!message.runId || pendingCardByRun.has(message.runId)) continue;
    const parsed = MessageBlockSchema.array().safeParse(message.blocks);
    if (!parsed.success) continue;
    const block = parsed.data.find((candidate) => attentionKindForBlock(candidate) !== null);
    if (block) pendingCardByRun.set(message.runId, { messageId: message.id, block });
  }

  const items: AttentionItem[] = [];
  const busyBots = new Set<string>();

  for (const run of waitingRuns as WaitingRun[]) {
    busyBots.add(run.botId);
    if (run.status === "waiting_takeover") {
      items.push(
        runItem(run, {
          kind: "takeover",
          detail: "",
          createdAt: run.updatedAt,
        }),
      );
      continue;
    }
    const card = pendingCardByRun.get(run.id);
    if (!card) {
      items.push(
        runItem(run, {
          kind: "question",
          detail: activityPreview({ trigger: run.trigger, prompt: run.task.prompt }).promptSnippet,
          createdAt: run.updatedAt,
        }),
      );
      continue;
    }
    const kind = attentionKindForBlock(card.block);
    if (!kind) continue;
    const detail =
      card.block.kind === "choice"
        ? card.block.question
        : card.block.kind === "ask"
          ? card.block.detail && !card.block.text.includes(card.block.detail)
            ? `${card.block.text} · ${card.block.detail}`
            : card.block.text || card.block.detail || run.task.prompt
          : run.task.prompt;
    items.push(
      runItem(run, {
        kind,
        detail,
        createdAt: run.updatedAt,
        messageId: card.messageId,
        actions: attentionActionsForBlock(card.block),
      }),
    );
  }

  for (const run of failedRuns as FailedRun[]) {
    if (run.status !== "failed") continue;
    if (busyBots.has(run.botId)) continue;
    busyBots.add(run.botId);
    items.push(
      runItem(run, {
        kind: "failed",
        detail: activityPreview({ trigger: run.trigger, prompt: run.task.prompt }).promptSnippet,
        createdAt: run.completedAt ?? run.updatedAt,
      }),
    );
  }

  for (const routine of routines as RoutineRow[]) {
    if (busyBots.has(routine.botId)) continue;
    const nextRunAt = routine.nextRunAt?.getTime() ?? null;
    if (!routineScheduleDelayed({ active: true, nextRunAt }, now.getTime())) continue;
    const thread = routineThread(routine);
    if (!thread) continue;
    busyBots.add(routine.botId);
    items.push({
      id: `routine:${routine.id}`,
      kind: "routine_delayed",
      botId: routine.botId,
      botName: routine.bot.name,
      groupId: thread.groupId,
      groupName: thread.group?.name ?? null,
      threadId: thread.id,
      runId: null,
      routineId: routine.id,
      messageId: null,
      detail: routine.name,
      createdAt: (routine.nextRunAt ?? now).toISOString(),
      actions: [],
    });
  }

  return sortAttentionItems(items);
}
