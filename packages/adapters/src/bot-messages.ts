import { type JobPublisher, runContinueJob } from "@rakazo/adapter-kit";
import type { BotChannel, MessageBlock } from "@rakazo/contracts";
import { createThreadMessage, type PrismaClient, type ThreadEvents } from "@rakazo/db";

const PING_PONG_WINDOW_MS = 5 * 60 * 1000;
const PING_PONG_LIMIT = 8;

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
    fromBotName: string;
    fromBotColor: string;
    fromThreadId: string;
    sourceRunId: string;
    name: string;
    text: string;
    botId?: string;
  },
): Promise<
  { ok: true; channelId: string; peerBotId: string; peerName: string } | { error: string }
> {
  const name = input.name.trim();
  const text = input.text.trim();
  if (!name) return { error: "Bot name is required." };
  if (!text) return { error: "Message text is required." };
  if (text.length > 8000) return { error: "Message is too long." };

  const teammates = await deps.prisma.bot.findMany({
    where: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      archivedAt: null,
      id: { not: input.fromBotId },
    },
    select: { id: true, name: true, color: true, thread: { select: { id: true } } },
  });
  const matches = input.botId
    ? teammates.filter((bot) => bot.id === input.botId)
    : teammates.filter((bot) => bot.name.toLowerCase() === name.toLowerCase());
  if (input.botId && matches.length === 0) {
    return { error: "That bot is not in this workspace." };
  }
  if (!input.botId && matches.length === 0) {
    return { error: `No bot named "${name}" in this workspace.` };
  }
  if (!input.botId && matches.length > 1) {
    return { error: `More than one bot is named "${name}". Pass bot_id as well.` };
  }
  const peer = matches[0]!;
  if (!peer.thread) return { error: `${peer.name} has no thread.` };
  if (peer.id === input.fromBotId) return { error: "A bot cannot message itself." };

  const [botAId, botBId] = orderedBotPair(input.fromBotId, peer.id);
  const channel = await deps.prisma.botChannel.upsert({
    where: {
      workspaceId_botAId_botBId: { workspaceId: input.workspaceId, botAId, botBId },
    },
    create: { workspaceId: input.workspaceId, botAId, botBId },
    update: {},
  });
  const recent = await deps.prisma.botChannelMessage.findMany({
    where: { channelId: channel.id },
    orderBy: { createdAt: "desc" },
    take: PING_PONG_LIMIT,
    select: { createdAt: true },
  });
  if (pingPongBlocked(recent.map((row) => row.createdAt))) {
    return {
      error: "Too many back-and-forth messages. Summarize for the user instead of ping-ponging.",
    };
  }

  const outbound: MessageBlock = {
    kind: "bot_message",
    direction: "out",
    channelId: channel.id,
    peerBotId: peer.id,
    peerName: peer.name,
    peerColor: peer.color,
    text,
  };
  const inbound: MessageBlock = {
    kind: "bot_message",
    direction: "in",
    channelId: channel.id,
    peerBotId: input.fromBotId,
    peerName: input.fromBotName,
    peerColor: input.fromBotColor,
    text,
  };

  const outboundMessage = await createThreadMessage(deps.prisma, {
    threadId: input.fromThreadId,
    role: "bot",
    blocks: [outbound],
    runId: input.sourceRunId,
  });
  await deps.events.append({
    workspaceId: input.workspaceId,
    threadId: input.fromThreadId,
    botId: input.fromBotId,
    type: "thread.message.created",
    runId: input.sourceRunId,
    payload: { messageId: outboundMessage.id, role: "bot", blocks: [outbound] },
  });

  const inboundMessage = await createThreadMessage(deps.prisma, {
    threadId: peer.thread.id,
    role: "user",
    blocks: [inbound],
  });
  await deps.prisma.thread.update({
    where: { id: peer.thread.id },
    data: { unread: true },
  });
  const recipientRun = await enqueueRecipientRun(deps, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    botId: peer.id,
    threadId: peer.thread.id,
    sourceRunId: input.sourceRunId,
    prompt: `Message from ${input.fromBotName}:\n${text}\n\nIf they need a reply, message_bot ${input.fromBotName}. Keep it short. Don't ping-pong.`,
  });
  await deps.events.append({
    workspaceId: input.workspaceId,
    threadId: peer.thread.id,
    botId: peer.id,
    type: "thread.message.created",
    runId: recipientRun?.id,
    payload: { messageId: inboundMessage.id, role: "user", blocks: [inbound] },
  });

  await deps.prisma.botChannelMessage.create({
    data: {
      channelId: channel.id,
      fromBotId: input.fromBotId,
      toBotId: peer.id,
      text,
      sourceRunId: input.sourceRunId,
    },
  });

  if (recipientRun) {
    await deps.jobs.enqueue(runContinueJob(recipientRun.id)).catch((error) => {
      console.error("bot message enqueue", error);
    });
  }

  return { ok: true, channelId: channel.id, peerBotId: peer.id, peerName: peer.name };
}

async function enqueueRecipientRun(
  deps: { prisma: PrismaClient },
  input: {
    workspaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    sourceRunId: string;
    prompt: string;
  },
) {
  const busy = await deps.prisma.run.findFirst({
    where: { botId: input.botId, status: { in: ["running", "queued", "leased"] } },
    select: { id: true },
  });
  if (busy) return null;
  const clientNonce = `botmsg:${input.sourceRunId}:${input.botId}`;
  const existing = await deps.prisma.run.findUnique({
    where: { workspaceId_clientNonce: { workspaceId: input.workspaceId, clientNonce } },
  });
  if (existing) return existing;
  try {
    const task = await deps.prisma.task.create({
      data: {
        workspaceId: input.workspaceId,
        botId: input.botId,
        threadId: input.threadId,
        userId: input.userId,
        prompt: input.prompt,
        status: "queued",
      },
    });
    return await deps.prisma.run.create({
      data: {
        workspaceId: input.workspaceId,
        botId: input.botId,
        threadId: input.threadId,
        taskId: task.id,
        userId: input.userId,
        status: "queued",
        trigger: "bot_message",
        clientNonce,
      },
    });
  } catch {
    return deps.prisma.run.findUnique({
      where: { workspaceId_clientNonce: { workspaceId: input.workspaceId, clientNonce } },
    });
  }
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
    include: { messages: { orderBy: { createdAt: "asc" }, take: 200 } },
  });
  return {
    channelId: channel?.id ?? `${left.id}:${right.id}`,
    left,
    right,
    messages: (channel?.messages ?? []).map((message) => ({
      id: message.id,
      fromBotId: message.fromBotId,
      toBotId: message.toBotId,
      text: message.text,
      createdAt: message.createdAt.toISOString(),
    })),
  };
}
