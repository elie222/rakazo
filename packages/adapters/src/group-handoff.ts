import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { createThreadMessage, type PrismaClient, touchGroupUpdatedAt } from "@rakazo/db";
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
  const members = await deps.prisma.chatGroupMember.findMany({
    where: { groupId },
    include: { bot: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  let targetId = input.bot_id?.trim();
  if (!targetId && input.confirm_name?.trim()) {
    const name = input.confirm_name.trim().toLowerCase();
    targetId = members.find((member) => member.bot.name.toLowerCase() === name)?.bot.id;
  }
  if (!targetId) return { error: "handoff target bot is required" };
  if (targetId === run.botId) return { error: "cannot hand off to yourself" };
  if (!members.some((member) => member.bot.id === targetId)) {
    return { error: "handoff target is not a group member" };
  }

  const handoffBlock: MessageBlock = {
    kind: "handoff",
    fromBotId: run.botId,
    toBotId: targetId,
    text: input.message,
  };
  const message = await createThreadMessage(deps.prisma, {
    threadId: run.threadId,
    role: "bot",
    blocks: [handoffBlock],
    botId: run.botId,
    runId: run.id,
  });
  await deps.events.append({
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
  await touchGroupUpdatedAt(deps.prisma, groupId);

  const task = await deps.prisma.task.create({
    data: {
      workspaceId: run.workspaceId,
      botId: targetId,
      threadId: run.threadId,
      userId: run.userId,
      prompt: input.message,
      status: "queued",
    },
  });
  const nextRun = await deps.prisma.run.create({
    data: {
      workspaceId: run.workspaceId,
      botId: targetId,
      threadId: run.threadId,
      taskId: task.id,
      userId: run.userId,
      status: "queued",
      trigger: "user",
    },
  });
  await deps.jobs.enqueue(runContinueJob(nextRun.id));
  return { ok: true, botId: targetId, runId: nextRun.id };
}

export async function loadGroupContext(
  prisma: PrismaClient,
  groupId: string,
): Promise<string | undefined> {
  const group = await prisma.chatGroup.findUnique({
    where: { id: groupId },
    include: {
      members: {
        include: { bot: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!group) return undefined;
  const roster = group.members.map((member) => `${member.bot.name} (${member.bot.id})`).join(", ");
  return [
    `You are in the group chat "${group.name}" with: ${roster}.`,
    "Post in this shared thread. When another teammate should take the next stage, use handoff_to_bot instead of telling the user to switch chats.",
    "One bot owns each stage. @everyone exists for the user; use sparingly.",
  ].join(" ");
}
