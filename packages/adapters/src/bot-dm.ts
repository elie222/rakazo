import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { CHAT_GROUP_KIND_BOT_DM } from "@rakazo/contracts";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
  type PrismaClient,
  touchGroupUpdatedAt,
} from "@rakazo/db";
import type { ExecutorDeps } from "./executor.js";

export function botDmPairKey(botA: string, botB: string): string {
  return [botA, botB].sort().join(":");
}

function isPairKeyUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

async function lookupBotDmThread(
  prisma: Pick<PrismaClient, "chatGroup">,
  actor: { workspaceId: string; userId: string },
  pairKey: string,
) {
  const existing = await prisma.chatGroup.findFirst({
    where: {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      kind: CHAT_GROUP_KIND_BOT_DM,
      pairKey,
    },
    include: { thread: { select: { id: true } } },
  });
  if (!existing?.thread) return undefined;
  return { groupId: existing.id, threadId: existing.thread.id };
}

async function resolveWorkspaceBotTarget(
  prisma: PrismaClient,
  actor: { workspaceId: string; userId: string },
  sourceBotId: string,
  input: { bot_id?: string; confirm_name?: string },
) {
  const bots = await prisma.bot.findMany({
    where: {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      archivedAt: null,
    },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  let targetId = input.bot_id?.trim();
  if (!targetId && input.confirm_name?.trim()) {
    const name = input.confirm_name.trim().toLowerCase();
    targetId = bots.find((bot) => bot.name.toLowerCase() === name)?.id;
  }
  if (!targetId) return { error: "target bot is required" } as const;
  if (targetId === sourceBotId) return { error: "cannot message yourself" } as const;
  const target = bots.find((bot) => bot.id === targetId);
  if (!target) return { error: "target bot is not in this workspace" } as const;
  const source = bots.find((bot) => bot.id === sourceBotId);
  if (!source) return { error: "source bot is no longer available" } as const;
  return { ok: true as const, source, target };
}

export async function findOrCreateBotDmThread(
  prisma: PrismaClient,
  actor: { workspaceId: string; userId: string },
  sourceBotId: string,
  targetBotId: string,
) {
  const pairKey = botDmPairKey(sourceBotId, targetBotId);
  const existing = await lookupBotDmThread(prisma, actor, pairKey);
  if (existing) return existing;

  const bots = await prisma.bot.findMany({
    where: {
      id: { in: [sourceBotId, targetBotId] },
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      archivedAt: null,
    },
    select: { id: true, name: true },
  });
  if (bots.length !== 2) throw new IsolationError();
  const source = bots.find((bot) => bot.id === sourceBotId);
  const target = bots.find((bot) => bot.id === targetBotId);
  if (!source || !target) throw new IsolationError();

  for (let attempt = 0; attempt < 3; attempt++) {
    const raced = await lookupBotDmThread(prisma, actor, pairKey);
    if (raced) return raced;
    try {
      return await prisma.$transaction(async (tx) => {
        const locked = await lookupBotDmThread(tx, actor, pairKey);
        if (locked) return locked;

        const group = await tx.chatGroup.create({
          data: {
            workspaceId: actor.workspaceId,
            userId: actor.userId,
            name: `${source.name} → ${target.name}`,
            kind: CHAT_GROUP_KIND_BOT_DM,
            pairKey,
          },
        });
        await tx.chatGroupMember.createMany({
          data: [
            { groupId: group.id, botId: sourceBotId },
            { groupId: group.id, botId: targetBotId },
          ],
        });
        const thread = await tx.thread.create({
          data: {
            workspaceId: actor.workspaceId,
            groupId: group.id,
            userId: actor.userId,
          },
        });
        return { groupId: group.id, threadId: thread.id };
      });
    } catch (error) {
      if (isPairKeyUniqueViolation(error)) continue;
      throw error;
    }
  }

  const final = await lookupBotDmThread(prisma, actor, pairKey);
  if (final) return final;
  throw new Error("Failed to resolve bot DM thread");
}

export async function messageBot(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: {
    id: string;
    workspaceId: string;
    threadId: string;
    botId: string;
    userId: string;
  },
  input: { bot_id?: string; confirm_name?: string; message: string },
) {
  const message = input.message.trim();
  if (!message) return { error: "message is required" } as const;

  const resolved = await resolveWorkspaceBotTarget(deps.prisma, run, run.botId, input);
  if ("error" in resolved) return resolved;

  const dm = await findOrCreateBotDmThread(deps.prisma, run, run.botId, resolved.target.id);
  const sameThread = run.threadId === dm.threadId;

  const handoffBlock: MessageBlock = {
    kind: "handoff",
    fromBotId: run.botId,
    toBotId: resolved.target.id,
    text: message,
  };

  const committed = await deps.prisma.$transaction(async (tx) => {
    const activeSource = await tx.run.findFirst({
      where: {
        id: run.id,
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        botId: run.botId,
        userId: run.userId,
        status: "running",
      },
      select: { id: true },
    });
    if (!activeSource) return { error: "source run is no longer active" } as const;

    const dmMessage = await createThreadMessageInTransaction(tx, {
      threadId: dm.threadId,
      role: "bot",
      blocks: [handoffBlock],
      botId: run.botId,
      runId: run.id,
    });
    if (!sameThread) {
      await createThreadMessageInTransaction(tx, {
        threadId: run.threadId,
        role: "bot",
        blocks: [handoffBlock],
        botId: run.botId,
        runId: run.id,
      });
    }
    const task = await tx.task.create({
      data: {
        workspaceId: run.workspaceId,
        botId: resolved.target.id,
        threadId: dm.threadId,
        userId: run.userId,
        prompt: message,
        status: "queued",
      },
    });
    const nextRun = await tx.run.create({
      data: {
        workspaceId: run.workspaceId,
        botId: resolved.target.id,
        threadId: dm.threadId,
        taskId: task.id,
        userId: run.userId,
        status: "queued",
        trigger: "user",
        sourceMessageId: dmMessage.id,
      },
    });
    const dmEvent = await appendEventInTransaction(tx, {
      workspaceId: run.workspaceId,
      threadId: dm.threadId,
      botId: run.botId,
      type: "bot.dm",
      runId: run.id,
      payload: {
        messageId: dmMessage.id,
        groupId: dm.groupId,
        fromBotId: run.botId,
        toBotId: resolved.target.id,
        text: message,
      },
    });
    const sourceEventSeq = sameThread
      ? dmEvent.seq
      : (
          await appendEventInTransaction(tx, {
            workspaceId: run.workspaceId,
            threadId: run.threadId,
            botId: run.botId,
            type: "bot.dm",
            runId: run.id,
            payload: {
              messageId: dmMessage.id,
              groupId: dm.groupId,
              fromBotId: run.botId,
              toBotId: resolved.target.id,
              text: message,
            },
          })
        ).seq;
    await touchGroupUpdatedAt(tx, dm.groupId);
    return {
      ok: true as const,
      groupId: dm.groupId,
      threadId: dm.threadId,
      botId: resolved.target.id,
      runId: nextRun.id,
      dmEventSeq: dmEvent.seq,
      sourceEventSeq,
    };
  });

  if ("error" in committed) return committed;
  await deps.events.notify(dm.threadId, committed.dmEventSeq).catch((error) => {
    console.error("bot dm realtime notification", error);
  });
  if (run.threadId !== dm.threadId) {
    await deps.events.notify(run.threadId, committed.sourceEventSeq).catch((error) => {
      console.error("bot dm source notification", error);
    });
  }
  await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
    console.error("bot dm enqueue", error);
  });
  return {
    ok: true,
    groupId: committed.groupId,
    threadId: committed.threadId,
    botId: committed.botId,
    runId: committed.runId,
  };
}

export async function loadBotDmContext(
  prisma: PrismaClient,
  groupId: string,
  receivingBotId: string,
): Promise<string | undefined> {
  const group = await prisma.chatGroup.findUnique({
    where: { id: groupId },
    include: {
      members: {
        where: { bot: { archivedAt: null } },
        include: { bot: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!group || group.kind !== CHAT_GROUP_KIND_BOT_DM) return undefined;
  const self = group.members.find((member) => member.bot.id === receivingBotId);
  const peer = group.members.find((member) => member.bot.id !== receivingBotId);
  if (!self || !peer) return undefined;
  return [
    `You are in a direct bot conversation with ${peer.bot.name} (${peer.bot.id}).`,
    "Messages here come from your teammate bots, not the human directly.",
    "Do the requested work in this thread. You may reply with message_bot when another bot should take the next step.",
  ].join(" ");
}
