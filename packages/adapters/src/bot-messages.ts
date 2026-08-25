import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  botMessageHopExhausted,
  clampBotMessage,
  nextBotMessageHop,
  resolveBotAddress,
} from "@rakazo/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  type PrismaClient,
} from "@rakazo/db";
import type { ExecutorDeps } from "./executor.js";

/**
 * The hop the current run sits at, read back from the message that woke this
 * bot. A run a person started carries no bot message, so it starts at 0.
 */
export async function currentBotMessageHop(
  prisma: PrismaClient,
  sourceMessageId: string | null | undefined,
): Promise<number> {
  if (!sourceMessageId) return 0;
  const source = await prisma.message.findUnique({
    where: { id: sourceMessageId },
    select: { blocks: true },
  });
  const blocks = Array.isArray(source?.blocks) ? (source.blocks as MessageBlock[]) : [];
  for (const block of blocks) {
    if (block.kind === "bot_message_received" && typeof block.hop === "number") return block.hop;
  }
  return 0;
}

export async function messageBot(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: {
    id: string;
    workspaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
  },
  sender: { id: string; name: string },
  input: { bot_id?: string; confirm_name?: string; message: string },
) {
  const message = clampBotMessage(String(input.message ?? ""));
  if (!message) return { ok: false as const, error: "message is required" };

  const hop = nextBotMessageHop(
    await currentBotMessageHop(deps.prisma, run.sourceMessageId ?? null),
  );
  if (botMessageHopExhausted(hop)) {
    return {
      ok: false as const,
      error:
        "bot-to-bot message limit reached for this chain; report back to the user instead of messaging another bot",
    };
  }

  const candidates = await deps.prisma.bot.findMany({
    where: { workspaceId: run.workspaceId, userId: run.userId, archivedAt: null },
    select: { id: true, name: true, title: true, thread: { select: { id: true } } },
  });
  const target = resolveBotAddress(candidates, {
    botId: input.bot_id,
    name: input.confirm_name,
  });
  if (!target) return { ok: false as const, error: "no bot found with that id or name" };
  if (target.id === sender.id) return { ok: false as const, error: "a bot cannot message itself" };
  if (!target.thread)
    return { ok: false as const, error: `${target.name} has no chat to deliver to` };

  const targetThreadId = target.thread.id;
  const committed = await deps.prisma.$transaction(async (tx) => {
    const senderStillRunning = await tx.run.findFirst({
      where: { id: run.id, status: "running" },
      select: { id: true },
    });
    if (!senderStillRunning) return { ok: false as const, error: "source run is no longer active" };

    const inboundBlock: MessageBlock = {
      kind: "bot_message_received",
      fromBotId: sender.id,
      fromBotName: sender.name,
      text: message,
      hop,
    };
    // Delivered as a user-role turn: for the recipient this is the prompt that
    // woke it, exactly like a person typing in its chat.
    const inbound = await createThreadMessageInTransaction(tx, {
      threadId: targetThreadId,
      role: "user",
      blocks: [inboundBlock],
    });
    const task = await tx.task.create({
      data: {
        workspaceId: run.workspaceId,
        botId: target.id,
        threadId: targetThreadId,
        userId: run.userId,
        prompt: message,
        status: "queued",
      },
    });
    const nextRun = await tx.run.create({
      data: {
        workspaceId: run.workspaceId,
        botId: target.id,
        threadId: targetThreadId,
        taskId: task.id,
        userId: run.userId,
        status: "queued",
        trigger: "bot_message",
        sourceMessageId: inbound.id,
      },
      select: { id: true },
    });
    await tx.message.update({ where: { id: inbound.id }, data: { runId: nextRun.id } });
    const event = await appendEventInTransaction(tx, {
      workspaceId: run.workspaceId,
      threadId: targetThreadId,
      botId: target.id,
      type: "thread.message.created",
      runId: nextRun.id,
      payload: { messageId: inbound.id, role: "user", blocks: [inboundBlock] },
    });
    return { ok: true as const, runId: nextRun.id, eventSeq: event.seq };
  });
  if (!committed.ok) return committed;

  await deps.events.notify(targetThreadId, committed.eventSeq).catch((error) => {
    console.error("bot message realtime notification", error);
  });
  await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
    // The queued run is durable; the job reconciler repairs a missed wake.
    console.error("bot message enqueue", error);
  });
  return {
    ok: true as const,
    botId: target.id,
    name: target.name,
    delivered: message,
    note: `Sent to ${target.name}. Delivery is asynchronous — if they reply it arrives later as a new message that wakes you. Do not wait for it now.`,
  };
}
