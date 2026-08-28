import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { renderGroupMembersContext } from "@rakazo/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
  lockOwnedGroup,
  type PrismaClient,
  touchGroupUpdatedAt,
} from "@rakazo/db";
import type { ExecutorDeps } from "./executor.js";

export async function handoffToGroupBot(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: {
    id: string;
    workspaceId: string;
    threadId: string;
    botId: string;
    userId: string;
  },
  groupId: string,
  input: { bot_id?: string; confirm_name?: string; message: string },
) {
  const committed = await deps.prisma.$transaction(async (tx) => {
    try {
      await lockOwnedGroup(tx, run, groupId);
    } catch (error) {
      if (error instanceof IsolationError)
        return { error: "group is no longer available" } as const;
      throw error;
    }
    const [group, activeSource] = await Promise.all([
      tx.chatGroup.findFirst({
        where: { id: groupId, archivedAt: null, thread: { id: run.threadId } },
        include: {
          members: {
            where: { bot: { archivedAt: null } },
            include: { bot: { select: { id: true, name: true } } },
            orderBy: { createdAt: "asc" },
          },
        },
      }),
      tx.run.findFirst({
        where: {
          id: run.id,
          workspaceId: run.workspaceId,
          threadId: run.threadId,
          botId: run.botId,
          userId: run.userId,
          status: "running",
        },
        select: { id: true },
      }),
    ]);
    if (!group || !activeSource) return { error: "source run is no longer active" } as const;
    if (!group.members.some((member) => member.bot.id === run.botId)) {
      return { error: "source bot is no longer a group member" } as const;
    }

    let targetId = input.bot_id?.trim();
    if (!targetId && input.confirm_name?.trim()) {
      const name = input.confirm_name.trim().toLowerCase();
      targetId = group.members.find((member) => member.bot.name.toLowerCase() === name)?.bot.id;
    }
    if (!targetId) return { error: "handoff target bot is required" } as const;
    if (targetId === run.botId) return { error: "cannot hand off to yourself" } as const;
    if (!group.members.some((member) => member.bot.id === targetId)) {
      return { error: "handoff target is not a group member" } as const;
    }

    const handoffBlock: MessageBlock = {
      kind: "handoff",
      fromBotId: run.botId,
      toBotId: targetId,
      text: input.message,
    };
    const message = await createThreadMessageInTransaction(tx, {
      threadId: run.threadId,
      role: "bot",
      blocks: [handoffBlock],
      botId: run.botId,
      runId: run.id,
    });
    const task = await tx.task.create({
      data: {
        workspaceId: run.workspaceId,
        botId: targetId,
        threadId: run.threadId,
        userId: run.userId,
        prompt: input.message,
        status: "queued",
      },
    });
    const nextRun = await tx.run.create({
      data: {
        workspaceId: run.workspaceId,
        botId: targetId,
        threadId: run.threadId,
        taskId: task.id,
        userId: run.userId,
        status: "queued",
        trigger: "user",
        sourceMessageId: message.id,
      },
    });
    const event = await appendEventInTransaction(tx, {
      workspaceId: run.workspaceId,
      threadId: run.threadId,
      botId: run.botId,
      type: "group.handoff",
      runId: run.id,
      payload: {
        messageId: message.id,
        fromBotId: run.botId,
        toBotId: targetId,
        text: input.message,
      },
    });
    await touchGroupUpdatedAt(tx, groupId);
    return { ok: true, botId: targetId, runId: nextRun.id, eventSeq: event.seq } as const;
  });
  if ("error" in committed) return committed;
  await deps.events.notify(run.threadId, committed.eventSeq).catch((error) => {
    console.error("group handoff realtime notification", error);
  });
  await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
    // The queued run is durable and the job reconciler will repair a missed immediate wake.
    console.error("group handoff enqueue", error);
  });
  return { ok: true, botId: committed.botId, runId: committed.runId };
}

export async function loadGroupContext(
  prisma: PrismaClient,
  groupId: string,
): Promise<string | undefined> {
  const group = await prisma.chatGroup.findUnique({
    where: { id: groupId },
    include: {
      members: {
        where: { bot: { archivedAt: null } },
        include: {
          bot: { select: { id: true, name: true, title: true, description: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!group) return undefined;
  return renderGroupMembersContext(
    group.name,
    group.members.map((member) => member.bot),
  );
}
