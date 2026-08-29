import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  botMessageHopExhausted,
  buildBotMessageWakePrompt,
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
  input: { bot_id?: string; confirm_name?: string; message: string; deliveryKey?: string },
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

  // A tool call can be re-executed after a lease expiry, so a delivery has to be
  // replayable: without this the recipient is messaged twice and woken twice.
  const deliveryKey = input.deliveryKey ? `bot-message:${input.deliveryKey}` : undefined;
  const replayed = () =>
    ({
      ok: true as const,
      botId: target.id,
      name: target.name,
      delivered: message,
      replayed: true as const,
      note: `Already sent to ${target.name} in this turn; it was not sent again.`,
    }) as const;

  const wakePrompt = buildBotMessageWakePrompt({ from: sender, text: message });
  const outboundBlock: MessageBlock = {
    kind: "bot_message_sent",
    toBotId: target.id,
    toBotName: target.name,
    text: message,
  };

  let committed:
    | {
        ok: true;
        runId: string;
        targetEventSeq: number;
        senderEventSeq: number;
      }
    | {
        ok: false;
        error: string;
      }
    | {
        ok: true;
        replayed: true;
      };
  try {
    committed = await deps.prisma.$transaction(async (tx) => {
      // Claim the delivery key inside the transaction so a concurrent retry
      // either sees the winner or loses on the unique (threadId, clientNonce).
      if (deliveryKey) {
        const already = await tx.message.findUnique({
          where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
          select: { id: true },
        });
        if (already) return { ok: true as const, replayed: true as const };
      }

      const senderStillRunning = await tx.run.findFirst({
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
      if (!senderStillRunning)
        return { ok: false as const, error: "source run is no longer active" };

      // Re-read the target inside the transaction: it can be archived between
      // resolving it above and committing here.
      const stillAddressable = await tx.bot.findFirst({
        where: {
          id: target.id,
          workspaceId: run.workspaceId,
          userId: run.userId,
          archivedAt: null,
        },
        select: { id: true },
      });
      if (!stillAddressable)
        return { ok: false as const, error: `${target.name} is no longer available` };

      const inboundBlock: MessageBlock = {
        kind: "bot_message_received",
        fromBotId: sender.id,
        fromBotName: sender.name,
        text: message,
        hop,
      };
      // Delivered as a user-role turn: for the recipient this is the prompt that
      // woke it. The stored block keeps the raw text for the UI; the task prompt
      // names the sender and marks the body untrusted.
      const inbound = await createThreadMessageInTransaction(tx, {
        threadId: targetThreadId,
        role: "user",
        blocks: [inboundBlock],
        clientNonce: deliveryKey,
      });
      // Echo into the sender's chat in the same transaction so a failed notify
      // cannot leave one side delivered and the other blank.
      const outbound = await createThreadMessageInTransaction(tx, {
        threadId: run.threadId,
        role: "bot",
        blocks: [outboundBlock],
        botId: run.botId,
        runId: run.id,
      });
      const task = await tx.task.create({
        data: {
          workspaceId: run.workspaceId,
          botId: target.id,
          threadId: targetThreadId,
          userId: run.userId,
          prompt: wakePrompt,
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
      const inboundEvent = await appendEventInTransaction(tx, {
        workspaceId: run.workspaceId,
        threadId: targetThreadId,
        botId: target.id,
        type: "thread.message.created",
        runId: nextRun.id,
        payload: { messageId: inbound.id, role: "user", blocks: [inboundBlock] },
      });
      const outboundEvent = await appendEventInTransaction(tx, {
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        botId: run.botId,
        type: "thread.message.created",
        runId: run.id,
        payload: { messageId: outbound.id, role: "bot", blocks: [outboundBlock] },
      });
      return {
        ok: true as const,
        runId: nextRun.id,
        targetEventSeq: inboundEvent.seq,
        senderEventSeq: outboundEvent.seq,
      };
    });
  } catch (error) {
    // Two concurrent retries can both miss the in-transaction lookup; the
    // loser hits the unique key. Treat that as a successful replay.
    if (deliveryKey && isUniqueConstraintError(error)) {
      const winner = await deps.prisma.message.findUnique({
        where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
        select: { id: true },
      });
      if (winner) return replayed();
    }
    throw error;
  }
  if ("replayed" in committed) return replayed();
  if (!committed.ok) return committed;

  await deps.events.notify(targetThreadId, committed.targetEventSeq).catch((error) => {
    console.error("bot message realtime notification", error);
  });
  await deps.events.notify(run.threadId, committed.senderEventSeq).catch((error) => {
    console.error("bot message sender echo notification", error);
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
    note: `Sent to ${target.name}. Delivery is async; a reply wakes you later as a new message. Continue independent work; send another update later only if it adds something new.`,
  };
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}
