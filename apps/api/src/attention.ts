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
import { activityPreview } from "./runs.js";

const FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_WAITING_RUNS = 50;
const MAX_FAILED_RUNS = 20;
const MAX_ROUTINES = 50;
const MAX_DETAIL = 280;

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
        trigger: { notIn: [...BACKGROUND_RUN_TRIGGERS] },
        status: { in: ["waiting_input", "waiting_takeover"] },
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
        trigger: { notIn: [...BACKGROUND_RUN_TRIGGERS] },
        status: "failed",
        completedAt: { gte: new Date(now.getTime() - FAILED_WINDOW_MS) },
        thread: { unread: true },
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
      orderBy: [{ completedAt: "asc" }, { id: "asc" }],
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
        bot: {
          select: {
            name: true,
            thread: {
              select: {
                id: true,
                groupId: true,
                group: { select: { name: true } },
              },
            },
          },
        },
      },
      orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
      take: MAX_ROUTINES,
    }),
  ]);

  const messages = waitingRuns.length
    ? await prisma.message.findMany({
        where: { runId: { in: waitingRuns.map((run) => run.id) } },
        select: { id: true, runId: true, blocks: true },
        orderBy: [{ runId: "asc" }, { seq: "desc" }],
        take: MAX_WAITING_RUNS * 8,
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

  for (const routine of routines) {
    if (busyBots.has(routine.botId)) continue;
    const thread = routine.bot.thread;
    if (!thread) continue;
    const nextRunAt = routine.nextRunAt?.getTime() ?? null;
    if (!routineScheduleDelayed({ active: true, nextRunAt }, now.getTime())) continue;
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
