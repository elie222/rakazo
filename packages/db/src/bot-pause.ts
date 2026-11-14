import type { Actor } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { recordAuditEvent } from "./audit-events.js";
import { isOwnerRole } from "./billing.js";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { PrismaClient } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import type { ThreadEvents } from "./events.js";
import { appendEventInTransaction } from "./events.js";
import { IsolationError } from "./scope.js";
import { SpaceOwnerRequiredError } from "./space-members.js";
import { SpaceDeletionInProgressError } from "./spaces.js";
import { THREAD_LOCK_TRANSACTION_OPTIONS } from "./transaction-retry.js";

/**
 * A paused bot starts no new work. Refused like a Space being deleted, so every inbound path that
 * already drops or rejects that work (webhooks, email, chat apps, the RPC boundary) does the same.
 */
export class BotPausedError extends SpaceDeletionInProgressError {
  constructor() {
    super();
    this.message = "This bot is paused. Resume it to start new work.";
    this.name = "BotPausedError";
  }
}

export async function botPaused(db: Pick<PrismaClient, "bot">, botId: string): Promise<boolean> {
  const bot = await db.bot.findUnique({ where: { id: botId }, select: { pausedAt: true } });
  return Boolean(bot?.pausedAt);
}

/** The bot's owner or the Space's owner may pause and resume it. */
async function pausableBot(prisma: PrismaClient, actor: Actor, botId: string) {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, archivedAt: null },
    select: { id: true, name: true, userId: true },
  });
  if (!bot) throw new IsolationError();
  if (bot.userId !== actor.userId) {
    const member = await prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
      select: { role: true },
    });
    if (!member || !isOwnerRole(member.role)) throw new SpaceOwnerRequiredError();
  }
  return bot;
}

/**
 * Cancels the active runs of a paused bot (or just `runId`) and returns them. Does nothing for a
 * bot that is not paused. Routines keep their schedule: a paused bot skips their occurrences.
 */
export async function cancelPausedBotRuns(
  prisma: PrismaClient,
  events: Pick<ThreadEvents, "notify">,
  botId: string,
  runId?: string,
) {
  const committed = await prisma.$transaction(async (tx) => {
    if (!(await botPaused(tx, botId))) return [];
    const threads = await tx.run.findMany({
      where: { botId, status: { in: [...ACTIVE_RUN_STATUSES] }, ...(runId ? { id: runId } : {}) },
      distinct: ["threadId"],
      select: { threadId: true },
      orderBy: { threadId: "asc" },
    });
    // Thread locks come first, as in every writer of run state.
    for (const { threadId } of threads) {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
    }
    const runs = await tx.run.findMany({
      where: { botId, status: { in: [...ACTIVE_RUN_STATUSES] }, ...(runId ? { id: runId } : {}) },
      select: { id: true, taskId: true, userId: true, spaceId: true, threadId: true },
    });
    const cancelled = await cancelRunsInTransaction(tx, runs, new Date());
    await expireComputerExecutionLeases(tx, { runId: { in: cancelled.map((run) => run.id) } });
    const seqs = new Map<string, number>();
    for (const run of cancelled) {
      const event = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId,
        type: "run.cancelled",
        runId: run.id,
        payload: { reason: "bot_paused" },
      });
      seqs.set(run.threadId, event.seq);
    }
    return [...seqs].map(([threadId, seq]) => ({ threadId, seq, runs: cancelled }));
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  for (const { threadId, seq } of committed) {
    await events.notify(threadId, seq).catch((error) => {
      getLogger().error("paused bot run cancellation notification", error);
    });
  }
  return committed[0]?.runs ?? [];
}

/** Pauses the bot, cancels its active runs, and records who did it. */
export async function pauseBot(
  prisma: PrismaClient,
  events: Pick<ThreadEvents, "notify">,
  actor: Actor,
  botId: string,
) {
  const bot = await pausableBot(prisma, actor, botId);
  const { count } = await prisma.bot.updateMany({
    where: { id: bot.id, pausedAt: null },
    data: { pausedAt: new Date() },
  });
  const cancelled = await cancelPausedBotRuns(prisma, events, bot.id);
  if (count === 1) await auditBotPause(actor, bot, "bot.paused", cancelled.length);
  return cancelled;
}

/** Clears the pause; a routine or run stays as it was. */
export async function resumeBot(prisma: PrismaClient, actor: Actor, botId: string) {
  const bot = await pausableBot(prisma, actor, botId);
  const { count } = await prisma.bot.updateMany({
    where: { id: bot.id, pausedAt: { not: null } },
    data: { pausedAt: null },
  });
  if (count === 1) await auditBotPause(actor, bot, "bot.resumed");
}

function auditBotPause(
  actor: Actor,
  bot: { id: string; name: string },
  action: "bot.paused" | "bot.resumed",
  cancelledRuns?: number,
) {
  return recordAuditEvent({
    action,
    actor: { type: "user", id: actor.userId },
    spaceId: actor.spaceId,
    target: { type: "bot", id: bot.id, label: bot.name },
    metadata: cancelledRuns === undefined ? undefined : { cancelledRuns },
  });
}
