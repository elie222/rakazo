import type { JobPublisher } from "@rakazo/adapter-kit";
import type { LabFeature } from "@rakazo/contracts";
import {
  hasLab,
  isTicketCompletedStatus,
  resolveLabs,
  TicketStatusSchema,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { wakeRun } from "../runs/wakeups/wake-run.js";
import { ticketWakePrompt } from "../runs/wakeups/wakes.prompt.js";

/**
 * Create the assignee's wake run inside the caller's transaction. The ticket row is
 * locked first, so the bot this wakes owns the ticket as of this commit: a concurrent
 * reassignment cannot quietly redirect or drop the wake, and a delivery that commits a
 * ticket comment commits its continuation in the same transaction. `requireAssigneeBotId`
 * keeps the notifier's contract (wake only the bot the change named, while it still owns
 * the ticket); `skipBotId` spares a sender from being woken for its own message.
 */
export async function createTicketAssigneeWakeRun(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    ticketId: string;
    requireAssigneeBotId?: string;
    skipBotId?: string;
    deploymentLabs?: readonly LabFeature[];
    /**
     * The bot message this continuation answers, when the wake continues a bot-to-bot
     * exchange. Carrying it preserves the chain's hop lineage: the woken assignee's
     * next message_bot continues after the hop that woke the answering bot instead of
     * restarting at 1, so automated comment → wake → message cycles stay inside the
     * bot-message hop limit. Human-initiated wakes (assignment, ticket creation) pass
     * nothing and legitimately start a fresh chain.
     */
    sourceMessageId?: string | null;
  },
): Promise<string | null> {
  await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${input.ticketId} FOR UPDATE`;
  const ticket = await tx.ticket.findFirst({
    where: { id: input.ticketId, spaceId: input.spaceId },
    include: { board: { select: { ticketPrefix: true } } },
  });
  if (!ticket) return null;
  const assigneeBotId = ticket.assigneeBotId;
  if (!assigneeBotId) return null;
  if (input.requireAssigneeBotId !== undefined && assigneeBotId !== input.requireAssigneeBotId)
    return null;
  if (assigneeBotId === input.skipBotId) return null;
  const status = TicketStatusSchema.safeParse(ticket.status);
  if (!status.success || isTicketCompletedStatus(status.data)) return null;
  const bot = await tx.bot.findFirst({
    where: { id: assigneeBotId, spaceId: input.spaceId, archivedAt: null },
    select: { id: true, userId: true, thread: { select: { id: true } } },
  });
  if (!bot?.thread) return null;
  const owner = await tx.user.findUnique({ where: { id: bot.userId }, select: { labs: true } });
  if (!hasLab(resolveLabs(owner?.labs, input.deploymentLabs), "board")) return null;
  const task = await tx.task.create({
    data: {
      spaceId: input.spaceId,
      botId: bot.id,
      threadId: bot.thread.id,
      userId: bot.userId,
      prompt: ticketWakePrompt(`${ticket.board.ticketPrefix}-${ticket.number}`),
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: input.spaceId,
      botId: bot.id,
      threadId: bot.thread.id,
      userId: bot.userId,
      taskId: task.id,
      trigger: "tickets",
      status: "queued",
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    },
  });
  return run.id;
}

/** Assignment wakes only its current owner, without posting a chat message. */
export async function wakeTicketAssignee(
  deps: { prisma: PrismaClient; jobs: JobPublisher; deploymentLabs?: readonly LabFeature[] },
  input: { spaceId: string; ticketId: string; botId: string },
): Promise<void> {
  const runId = await deps.prisma.$transaction((tx) =>
    createTicketAssigneeWakeRun(tx, {
      spaceId: input.spaceId,
      ticketId: input.ticketId,
      requireAssigneeBotId: input.botId,
      deploymentLabs: deps.deploymentLabs,
    }),
  );
  if (!runId) return;
  await wakeRun(deps.jobs, runId);
}
