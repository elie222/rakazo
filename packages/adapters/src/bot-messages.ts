import { type JobPublisher, runContinueJob } from "@rakazo/adapter-kit";
import type { BotChannel, MessageBlock } from "@rakazo/contracts";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  Prisma,
  type PrismaClient,
  type ThreadEvents,
} from "@rakazo/db";

const PING_PONG_WINDOW_MS = 5 * 60 * 1000;
const PING_PONG_LIMIT = 8;
const CHANNEL_HISTORY_LIMIT = 200;

type MessageBotResult =
  | { ok: true; channelId: string; peerBotId: string; peerName: string }
  | { error: string };

type CommittedDelivery = {
  response: MessageBotResult;
  recipientRunId?: string;
  notifications: Array<{ threadId: string; seq: number }>;
};

export function orderedBotPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function pingPongBlocked(createdAt: Date[], now = Date.now()): boolean {
  const recent = createdAt.filter((at) => now - at.getTime() <= PING_PONG_WINDOW_MS);
  return recent.length >= PING_PONG_LIMIT;
}

export async function messageBot(
  deps: { prisma: PrismaClient; events: ThreadEvents; jobs: JobPublisher },
  input: {
    workspaceId: string;
    userId: string;
    fromBotId: string;
    sourceRunId: string;
    deliveryKey: string;
    name: string;
    text: string;
    botId?: string;
  },
): Promise<MessageBotResult> {
  const name = input.name.trim();
  const messageText = input.text.trim();
  if (!name) return { error: "Bot name is required." };
  if (!messageText) return { error: "Message text is required." };
  if (messageText.length > 8000) return { error: "Message is too long." };
  if (!input.deliveryKey.trim()) return { error: "Message delivery key is required." };
  if (input.botId === input.fromBotId) return { error: "A bot cannot message itself." };

  let committed: CommittedDelivery;
  try {
    committed = await deps.prisma.$transaction(async (tx) => {
      const sender = await tx.bot.findFirst({
        where: {
          id: input.fromBotId,
          workspaceId: input.workspaceId,
          userId: input.userId,
          archivedAt: null,
        },
        select: { id: true, name: true, color: true, thread: { select: { id: true } } },
      });
      if (!sender?.thread) return deliveryError("The sending bot is not available.");

      const sourceRun = await tx.run.findFirst({
        where: {
          id: input.sourceRunId,
          workspaceId: input.workspaceId,
          userId: input.userId,
          botId: sender.id,
          threadId: sender.thread.id,
          status: { not: "cancelled" },
        },
        select: { id: true },
      });
      if (!sourceRun) return deliveryError("The sending run is no longer available.");

      const replay = await findCommittedDelivery(tx, input);
      if (replay) return replay;

      const candidates = await tx.bot.findMany({
        where: {
          workspaceId: input.workspaceId,
          userId: input.userId,
          archivedAt: null,
          ...(input.botId
            ? { id: input.botId }
            : { name: { equals: name, mode: "insensitive" as const } }),
        },
        select: { id: true, name: true, color: true, thread: { select: { id: true } } },
        orderBy: { id: "asc" },
        take: 3,
      });
      if (!input.botId && candidates.length > 1) {
        return deliveryError(`More than one bot is named "${name}". Pass bot_id as well.`);
      }
      const peer = candidates[0];
      if (!peer) {
        return deliveryError(
          input.botId
            ? "That bot is not in this workspace."
            : `No bot named "${name}" in this workspace.`,
        );
      }
      if (peer.id === sender.id) return deliveryError("A bot cannot message itself.");
      if (!peer.thread) return deliveryError(`${peer.name} has no thread.`);

      const botIds = [sender.id, peer.id].sort();
      const lockedBots = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "bots"
        WHERE "id" IN (${Prisma.join(botIds)})
        ORDER BY "id"
        FOR UPDATE
      `;
      if (lockedBots.length !== 2) return deliveryError("One of the bots is no longer available.");

      const [botAId, botBId] = orderedBotPair(sender.id, peer.id);
      const channel = await tx.botChannel.upsert({
        where: {
          workspaceId_botAId_botBId: { workspaceId: input.workspaceId, botAId, botBId },
        },
        create: { workspaceId: input.workspaceId, botAId, botBId },
        update: {},
      });
      await tx.$queryRaw`
        SELECT "id" FROM "bot_channels" WHERE "id" = ${channel.id} FOR UPDATE
      `;

      const replayAfterLock = await findCommittedDelivery(tx, input);
      if (replayAfterLock) return replayAfterLock;

      const recent = await tx.botChannelMessage.findMany({
        where: { channelId: channel.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: PING_PONG_LIMIT,
        select: { createdAt: true },
      });
      if (pingPongBlocked(recent.map((row) => row.createdAt))) {
        return deliveryError(
          "Too many back-and-forth messages. Summarize for the user instead of ping-ponging.",
        );
      }

      const outbound: MessageBlock = {
        kind: "bot_message",
        direction: "out",
        channelId: channel.id,
        peerBotId: peer.id,
        peerName: peer.name,
        peerColor: peer.color,
        text: messageText,
      };
      const inbound: MessageBlock = {
        kind: "bot_message",
        direction: "in",
        channelId: channel.id,
        peerBotId: sender.id,
        peerName: sender.name,
        peerColor: sender.color,
        text: messageText,
      };
      const prompt = `Message from ${sender.name}:\n${messageText}\n\nIf they need a reply, message_bot ${sender.name}. Keep it short. Don't ping-pong.`;

      const task = await tx.task.create({
        data: {
          workspaceId: input.workspaceId,
          botId: peer.id,
          threadId: peer.thread.id,
          userId: input.userId,
          prompt,
          status: "queued",
        },
      });
      const recipientRun = await tx.run.create({
        data: {
          workspaceId: input.workspaceId,
          botId: peer.id,
          threadId: peer.thread.id,
          taskId: task.id,
          userId: input.userId,
          status: "queued",
          trigger: "bot_message",
          clientNonce: `botmsg:${input.deliveryKey}`,
        },
      });

      const threadIds = [sender.thread.id, peer.thread.id].sort();
      const lockedThreads = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "threads"
        WHERE "id" IN (${Prisma.join(threadIds)})
        ORDER BY "id"
        FOR UPDATE
      `;
      if (lockedThreads.length !== 2) throw new Error("A bot message thread disappeared");

      const outboundMessage = await createThreadMessageInTransaction(tx, {
        threadId: sender.thread.id,
        role: "bot",
        blocks: [outbound],
        runId: input.sourceRunId,
      });
      const outboundEvent = await appendEventInTransaction(tx, {
        workspaceId: input.workspaceId,
        threadId: sender.thread.id,
        botId: sender.id,
        type: "thread.message.created",
        runId: input.sourceRunId,
        payload: { messageId: outboundMessage.id, role: "bot", blocks: [outbound] },
      });

      const inboundMessage = await createThreadMessageInTransaction(tx, {
        threadId: peer.thread.id,
        role: "user",
        blocks: [inbound],
        runId: recipientRun.id,
      });
      await tx.thread.update({ where: { id: peer.thread.id }, data: { unread: true } });
      const inboundEvent = await appendEventInTransaction(tx, {
        workspaceId: input.workspaceId,
        threadId: peer.thread.id,
        botId: peer.id,
        type: "thread.message.created",
        runId: recipientRun.id,
        payload: { messageId: inboundMessage.id, role: "user", blocks: [inbound] },
      });

      await tx.botChannelMessage.create({
        data: {
          channelId: channel.id,
          fromBotId: sender.id,
          toBotId: peer.id,
          text: messageText,
          sourceRunId: input.sourceRunId,
          recipientRunId: recipientRun.id,
          deliveryKey: input.deliveryKey,
        },
      });

      return {
        response: {
          ok: true as const,
          channelId: channel.id,
          peerBotId: peer.id,
          peerName: peer.name,
        },
        recipientRunId: recipientRun.id,
        notifications: [
          { threadId: sender.thread.id, seq: outboundEvent.seq },
          { threadId: peer.thread.id, seq: inboundEvent.seq },
        ],
      };
    });
  } catch (error) {
    const recovered = await findCommittedDelivery(deps.prisma, input);
    if (!recovered) throw error;
    committed = recovered;
  }

  if (!("ok" in committed.response)) return committed.response;
  await Promise.all(
    committed.notifications.map(({ threadId, seq }) =>
      deps.events
        .notify(threadId, seq)
        .catch((error) => console.error("bot message realtime notification", error)),
    ),
  );
  if (committed.recipientRunId) {
    await deps.jobs.enqueue(runContinueJob(committed.recipientRunId)).catch((error) => {
      console.error("bot message enqueue", error);
    });
  }
  return committed.response;
}

function deliveryError(error: string): CommittedDelivery {
  return { response: { error }, notifications: [] };
}

async function findCommittedDelivery(
  prisma: Prisma.TransactionClient | PrismaClient,
  input: {
    deliveryKey: string;
    workspaceId: string;
    userId: string;
    fromBotId: string;
  },
): Promise<CommittedDelivery | null> {
  const existing = await prisma.botChannelMessage.findUnique({
    where: { deliveryKey: input.deliveryKey },
    include: { channel: { select: { id: true, workspaceId: true } } },
  });
  if (!existing) return null;
  if (
    existing.fromBotId !== input.fromBotId ||
    existing.channel.workspaceId !== input.workspaceId
  ) {
    throw new Error("Bot message delivery key belongs to another delivery");
  }
  const peer = await prisma.bot.findFirst({
    where: {
      id: existing.toBotId,
      workspaceId: input.workspaceId,
      userId: input.userId,
    },
    select: { name: true },
  });
  if (!peer) throw new Error("Delivered bot message recipient no longer exists");
  return {
    response: {
      ok: true,
      channelId: existing.channel.id,
      peerBotId: existing.toBotId,
      peerName: peer.name,
    },
    recipientRunId: existing.recipientRunId,
    notifications: [],
  };
}

export async function loadBotChannel(
  prisma: PrismaClient,
  input: { workspaceId: string; userId: string; botId: string; peerBotId: string },
): Promise<BotChannel | { error: string }> {
  if (input.botId === input.peerBotId) return { error: "Pick two different bots." };
  const bots = await prisma.bot.findMany({
    where: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      id: { in: [input.botId, input.peerBotId] },
    },
    select: { id: true, name: true, color: true },
  });
  const left = bots.find((bot) => bot.id === input.botId);
  const right = bots.find((bot) => bot.id === input.peerBotId);
  if (!left || !right) return { error: "Those bots are not in this workspace." };
  const [botAId, botBId] = orderedBotPair(left.id, right.id);
  const channel = await prisma.botChannel.findUnique({
    where: {
      workspaceId_botAId_botBId: { workspaceId: input.workspaceId, botAId, botBId },
    },
    include: {
      messages: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: CHANNEL_HISTORY_LIMIT + 1,
      },
    },
  });
  const newest = channel?.messages ?? [];
  return {
    channelId: channel?.id ?? `${left.id}:${right.id}`,
    left,
    right,
    messages: newest
      .slice(0, CHANNEL_HISTORY_LIMIT)
      .reverse()
      .map((message) => ({
        id: message.id,
        fromBotId: message.fromBotId,
        toBotId: message.toBotId,
        text: message.text,
        createdAt: message.createdAt.toISOString(),
      })),
    hasOlderMessages: newest.length > CHANNEL_HISTORY_LIMIT,
  };
}
