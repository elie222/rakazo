import { type JobPublisher, runContinueJob, runJobKey } from "@rakazo/adapter-kit";
import type { Actor, Channel, ChannelDetail, ChannelMessage } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, mentionedBotIds } from "@rakazo/core";
import { IsolationError, Prisma, type PrismaClient } from "@rakazo/db";

const HISTORY_LIMIT = 200;
const CONTEXT_LIMIT = 20;

export interface ChannelDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
}

interface ChannelRow {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  members: { bot: { id: string; name: string; color: string } | null }[];
}

interface ChannelMessageRow {
  id: string;
  authorType: string;
  authorBotId: string | null;
  text: string;
  createdAt: Date;
  authorBot: { name: string; color: string } | null;
}

const channelInclude = {
  members: {
    include: { bot: { select: { id: true, name: true, color: true } } },
    orderBy: { createdAt: "asc" },
  },
} as const;

const messageInclude = {
  authorBot: { select: { name: true, color: true } },
} as const;

function mapChannel(row: ChannelRow, preview: string): Channel {
  return {
    id: row.id,
    name: row.name,
    members: row.members.flatMap((member) =>
      member.bot ? [{ botId: member.bot.id, name: member.bot.name, color: member.bot.color }] : [],
    ),
    preview,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapChannelMessage(row: ChannelMessageRow, userName: string): ChannelMessage {
  const fromBot = row.authorType === "bot";
  return {
    id: row.id,
    authorType: fromBot ? "bot" : "user",
    authorBotId: row.authorBotId,
    authorName: fromBot ? (row.authorBot?.name ?? "Removed bot") : userName,
    authorColor: fromBot ? (row.authorBot?.color ?? null) : null,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
  };
}

async function requireChannel(prisma: PrismaClient, actor: Actor, channelId: string) {
  const channel = await prisma.channel.findFirst({
    where: { id: channelId, workspaceId: actor.workspaceId, userId: actor.userId },
    include: channelInclude,
  });
  if (!channel) throw new IsolationError();
  return channel;
}

/** Only bots the actor owns can join, so a channel can never reach across workspaces. */
async function ownedBotIds(
  prisma: PrismaClient | Prisma.TransactionClient,
  actor: Actor,
  botIds: string[],
) {
  const requested = [...new Set(botIds)];
  if (requested.length === 0) return [];
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM bots
    WHERE id IN (${Prisma.join(requested)})
      AND "workspaceId" = ${actor.workspaceId}
      AND "userId" = ${actor.userId}
      AND "archivedAt" IS NULL
    FOR SHARE
  `);
  if (rows.length !== requested.length) throw new IsolationError();
  return requested;
}

async function userDisplayName(prisma: PrismaClient | Prisma.TransactionClient, userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  return user?.name?.trim() || "You";
}

interface ActiveChannelRun {
  id: string;
  taskId: string;
}

async function cancelChannelRuns(
  tx: Prisma.TransactionClient,
  activeRuns: ActiveChannelRun[],
): Promise<void> {
  if (activeRuns.length === 0) return;
  const now = new Date();
  const runIds = activeRuns.map((run) => run.id);
  const taskIds = activeRuns.map((run) => run.taskId);
  await tx.run.updateMany({
    where: { id: { in: runIds }, status: { in: [...ACTIVE_RUN_STATUSES] } },
    data: { status: "cancelled", completedAt: now, leaseOwner: null, leaseExpiresAt: null },
  });
  await tx.attempt.updateMany({
    where: { runId: { in: runIds }, status: "running" },
    data: { status: "cancelled", finishedAt: now },
  });
  await tx.task.updateMany({
    where: { id: { in: taskIds }, runs: { some: { status: "cancelled", completedAt: now } } },
    data: { status: "cancelled" },
  });
  await tx.computerExecutionLease.deleteMany({ where: { runId: { in: runIds } } });
  await tx.computer.updateMany({
    where: { executionRunId: { in: runIds } },
    data: { executionRunId: null, executionBotId: null, executionLeaseExpiresAt: null },
  });
  await tx.event.deleteMany({
    where: { runId: { in: runIds }, type: "thread.progress" },
  });
}

export async function listChannels(prisma: PrismaClient, actor: Actor): Promise<Channel[]> {
  const rows = await prisma.channel.findMany({
    where: { workspaceId: actor.workspaceId, userId: actor.userId },
    include: {
      ...channelInclude,
      messages: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 },
    },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map((row) => mapChannel(row, row.messages[0]?.text ?? ""));
}

export async function getChannel(
  prisma: PrismaClient,
  actor: Actor,
  channelId: string,
): Promise<ChannelDetail> {
  const channel = await requireChannel(prisma, actor, channelId);
  const [messages, userName] = await Promise.all([
    prisma.channelMessage.findMany({
      where: { channelId: channel.id },
      include: messageInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: HISTORY_LIMIT,
    }),
    userDisplayName(prisma, actor.userId),
  ]);
  return {
    ...mapChannel(channel, messages[0]?.text ?? ""),
    messages: messages.reverse().map((message) => mapChannelMessage(message, userName)),
  };
}

export async function createChannel(
  prisma: PrismaClient,
  actor: Actor,
  input: { name: string; botIds: string[] },
): Promise<Channel> {
  const name = input.name.trim();
  if (!name) throw new IsolationError("Channel name is required");
  const created = await prisma.$transaction(async (tx) => {
    const members = await ownedBotIds(tx, actor, input.botIds);
    return tx.channel.create({
      data: {
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        name,
        members: { create: members.map((botId) => ({ botId })) },
      },
      include: channelInclude,
    });
  });
  return mapChannel(created, "");
}

export async function renameChannel(
  prisma: PrismaClient,
  actor: Actor,
  input: { channelId: string; name: string },
): Promise<Channel> {
  const name = input.name.trim();
  if (!name) throw new IsolationError("Channel name is required");
  await requireChannel(prisma, actor, input.channelId);
  const updated = await prisma.channel.update({
    where: { id: input.channelId },
    data: { name },
    include: channelInclude,
  });
  return mapChannel(updated, "");
}

export async function setChannelMembers(
  deps: ChannelDeps,
  actor: Actor,
  input: { channelId: string; botIds: string[] },
): Promise<Channel> {
  const result = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM channels WHERE id = ${input.channelId} FOR UPDATE`;
    const channel = await tx.channel.findFirst({
      where: { id: input.channelId, workspaceId: actor.workspaceId, userId: actor.userId },
      include: channelInclude,
    });
    if (!channel) throw new IsolationError();
    const members = await ownedBotIds(tx, actor, input.botIds);
    const nextMembers = new Set(members);
    const removedBotIds = channel.members.flatMap((member) =>
      member.bot && !nextMembers.has(member.bot.id) ? [member.bot.id] : [],
    );
    const activeRuns =
      removedBotIds.length === 0
        ? []
        : await tx.run.findMany({
            where: {
              channelId: channel.id,
              botId: { in: removedBotIds },
              status: { in: [...ACTIVE_RUN_STATUSES] },
            },
            select: { id: true, taskId: true },
          });
    await cancelChannelRuns(tx, activeRuns);
    await tx.channelMember.deleteMany({
      where: { channelId: input.channelId, botId: { notIn: members.length ? members : ["-"] } },
    });
    for (const botId of members) {
      await tx.channelMember.upsert({
        where: { channelId_botId: { channelId: input.channelId, botId } },
        create: { channelId: input.channelId, botId },
        update: {},
      });
    }
    const updated = await tx.channel.findUniqueOrThrow({
      where: { id: channel.id },
      include: channelInclude,
    });
    return { updated, runIds: activeRuns.map((run) => run.id) };
  });
  await Promise.allSettled(result.runIds.map((runId) => deps.jobs.cancel(runJobKey(runId))));
  return mapChannel(result.updated, "");
}

export async function removeChannel(
  deps: ChannelDeps,
  actor: Actor,
  channelId: string,
): Promise<{ ok: true }> {
  const runIds = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM channels WHERE id = ${channelId} FOR UPDATE`;
    const channel = await tx.channel.findFirst({
      where: { id: channelId, workspaceId: actor.workspaceId, userId: actor.userId },
      select: { id: true },
    });
    if (!channel) throw new IsolationError();
    const activeRuns = await tx.run.findMany({
      where: { channelId, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true, taskId: true },
    });
    await cancelChannelRuns(tx, activeRuns);
    await tx.channel.delete({ where: { id: channelId } });
    return activeRuns.map((run) => run.id);
  });
  await Promise.allSettled(runIds.map((runId) => deps.jobs.cancel(runJobKey(runId))));
  return { ok: true };
}

/**
 * A user message only wakes the members it names. Bot replies deliberately do not wake other
 * bots, so a channel cannot turn into an unbounded bot-to-bot loop.
 */
export async function postUserChannelMessage(
  deps: ChannelDeps,
  actor: Actor,
  input: { channelId: string; text: string; clientNonce: string },
): Promise<ChannelDetail> {
  const text = input.text.trim();
  const clientNonce = input.clientNonce.trim();
  if (!text || text.length > 8000 || !clientNonce || clientNonce.length > 128) {
    throw new IsolationError("Invalid channel message");
  }
  const result = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM channels WHERE id = ${input.channelId} FOR UPDATE`;
    const channel = await tx.channel.findFirst({
      where: { id: input.channelId, workspaceId: actor.workspaceId, userId: actor.userId },
      include: channelInclude,
    });
    if (!channel) throw new IsolationError();
    const existing = await tx.channelMessage.findFirst({
      where: { channelId: channel.id, userId: actor.userId, clientNonce },
      select: { id: true, text: true },
    });
    if (existing) {
      if (existing.text !== text) throw new IsolationError("Channel message nonce is already used");
      const runs = await tx.run.findMany({
        where: { channelMessageId: existing.id, status: "queued" },
        select: { id: true },
      });
      return { channelId: channel.id, runIds: runs.map((run) => run.id) };
    }

    const message = await tx.channelMessage.create({
      data: {
        channelId: channel.id,
        authorType: "user",
        userId: actor.userId,
        text,
        clientNonce,
      },
    });
    await tx.channel.update({ where: { id: channel.id }, data: { updatedAt: new Date() } });
    const candidates = channel.members.flatMap((member) =>
      member.bot ? [{ botId: member.bot.id, name: member.bot.name }] : [],
    );
    const mentioned = mentionedBotIds(text, candidates);
    if (mentioned.length === 0) return { channelId: channel.id, runIds: [] };

    const [bots, recent, userName] = await Promise.all([
      tx.bot.findMany({
        where: {
          id: { in: mentioned },
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          archivedAt: null,
          channelMemberships: { some: { channelId: channel.id } },
        },
        include: { thread: { select: { id: true } } },
      }),
      tx.channelMessage.findMany({
        where: { channelId: channel.id },
        include: messageInclude,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: CONTEXT_LIMIT,
      }),
      userDisplayName(tx, actor.userId),
    ]);
    if (bots.length !== mentioned.length) {
      throw new IsolationError();
    }
    const transcript = recent
      .reverse()
      .map((item) => {
        const author = item.authorType === "bot" ? (item.authorBot?.name ?? "bot") : userName;
        return `${author}: ${item.text}`;
      })
      .join("\n");
    const prompt = [
      `You were mentioned in the #${channel.name} channel.`,
      transcript ? `Recent channel messages:\n${transcript}` : "",
      `Reply to the channel with post_to_channel using channel_id "${channel.id}". Keep it short. Only the members named in a message are woken, so answer for yourself.`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const runIds: string[] = [];
    for (const bot of bots) {
      if (!bot.thread) throw new IsolationError();
      const task = await tx.task.create({
        data: {
          workspaceId: actor.workspaceId,
          botId: bot.id,
          threadId: bot.thread.id,
          userId: actor.userId,
          prompt,
          status: "queued",
        },
      });
      const run = await tx.run.create({
        data: {
          workspaceId: actor.workspaceId,
          botId: bot.id,
          threadId: bot.thread.id,
          taskId: task.id,
          userId: actor.userId,
          status: "queued",
          trigger: "channel",
          clientNonce: `channel:${message.id}:${bot.id}`,
          channelId: channel.id,
          channelMessageId: message.id,
        },
      });
      runIds.push(run.id);
    }
    return { channelId: channel.id, runIds };
  });
  await Promise.all(result.runIds.map((runId) => deps.jobs.enqueue(runContinueJob(runId))));
  return getChannel(deps.prisma, actor, result.channelId);
}

export type ChannelPostResult = { ok: true; channelId: string } | { error: string };

export function isUnavailableChannelPost(result: ChannelPostResult): boolean {
  return (
    "error" in result &&
    (result.error === "You are not a member of that channel." ||
      result.error === "That run cannot post to this channel.")
  );
}

export async function postBotChannelMessage(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    userId: string;
    channelId: string;
    botId: string;
    text: string;
    sourceRunId: string;
    sourceEffectId: string;
  },
): Promise<ChannelPostResult> {
  const text = input.text.trim();
  if (!text) return { error: "Message text is required." };
  if (text.length > 8000) return { error: "Message text is too long." };
  if (!input.sourceRunId || !input.sourceEffectId) return { error: "Message source is required." };
  return prisma.$transaction(async (tx) => {
    const channels = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM channels
      WHERE id = ${input.channelId}
        AND "workspaceId" = ${input.workspaceId}
        AND "userId" = ${input.userId}
      FOR SHARE
    `;
    const bots = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM bots
      WHERE id = ${input.botId}
        AND "workspaceId" = ${input.workspaceId}
        AND "userId" = ${input.userId}
        AND "archivedAt" IS NULL
      FOR SHARE
    `;
    const membership = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM channel_members
      WHERE "channelId" = ${input.channelId}
        AND "botId" = ${input.botId}
      FOR SHARE
    `;
    if (channels.length !== 1 || bots.length !== 1 || membership.length !== 1) {
      return { error: "You are not a member of that channel." };
    }
    const run = await tx.run.findFirst({
      where: {
        id: input.sourceRunId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        botId: input.botId,
        channelId: input.channelId,
        trigger: "channel",
      },
      select: { id: true },
    });
    if (!run) return { error: "That run cannot post to this channel." };
    const inserted = await tx.channelMessage.createMany({
      data: {
        channelId: input.channelId,
        authorType: "bot",
        authorBotId: input.botId,
        text,
        sourceRunId: input.sourceRunId,
        sourceEffectId: input.sourceEffectId,
      },
      skipDuplicates: true,
    });
    const message = await tx.channelMessage.findFirstOrThrow({
      where: { channelId: input.channelId, sourceEffectId: input.sourceEffectId },
      select: { authorBotId: true, sourceRunId: true, text: true },
    });
    if (
      message.authorBotId !== input.botId ||
      message.sourceRunId !== input.sourceRunId ||
      message.text !== text
    ) {
      return { error: "That channel post key is already in use." };
    }
    if (inserted.count === 1) {
      await tx.channel.update({ where: { id: input.channelId }, data: { updatedAt: new Date() } });
    }
    return { ok: true, channelId: input.channelId };
  });
}
