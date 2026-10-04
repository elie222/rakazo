import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob, ticketsCheckJob } from "@rakazo/adapter-kit";
import { ACTIONABLE_TICKET_STATUSES } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { BoardEvents, PrismaClient } from "@rakazo/db";
import { coerceTicketPriority, coerceTicketStatus } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { TicketWakeDecision, TicketWakeTicket, TicketWakeTrigger } from "./ticket-wake.js";
import {
  decideTicketWake,
  renderTicketWakePrompt,
  TICKET_CHECK_INTERVAL_MS,
  TICKET_WAKE_DEBOUNCE_MS,
} from "./ticket-wake.js";

export type TicketCheckDeps = {
  prisma: PrismaClient;
  jobs: JobPublisher;
  /** Lets a board show the owner bot as working as soon as a ticket run starts. */
  boardEvents?: Pick<BoardEvents, "notify">;
};

export type RunTicketChecksOptions = {
  trigger: TicketWakeTrigger;
  /** Check one bot (event-triggered); omit to sweep every bot (periodic). */
  botId?: string;
  now?: Date;
};

/**
 * Decide per bot whether its board justifies a wake, and start a run when it
 * does. Persisted `ticketsCheckedAt`/`ticketsWakeAt` keep the decision stable
 * across processes; the run itself is a normal queued Task+Run.
 */
export async function runTicketChecks(
  deps: TicketCheckDeps,
  options: RunTicketChecksOptions,
): Promise<void> {
  const now = options.now ?? new Date();
  const bots = await deps.prisma.bot.findMany({
    where: {
      archivedAt: null,
      ...(options.botId ? { id: options.botId } : {}),
    },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      name: true,
      ticketsCheckedAt: true,
      ticketsWakeAt: true,
      thread: { select: { id: true } },
    },
  });
  if (bots.length === 0) return;

  const botIds = bots.map((bot) => bot.id);
  const [tickets, lastComments, activeRuns] = await Promise.all([
    deps.prisma.ticket.findMany({
      where: {
        assigneeBotId: { in: botIds },
        status: { in: [...ACTIONABLE_TICKET_STATUSES] },
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        boardId: true,
        number: true,
        title: true,
        status: true,
        priority: true,
        assigneeBotId: true,
        updatedAt: true,
        updatedByBotId: true,
        externalUpdatedAt: true,
      },
    }),
    deps.prisma.ticketComment.findMany({
      where: {
        ticket: {
          assigneeBotId: { in: botIds },
          status: { in: [...ACTIONABLE_TICKET_STATUSES] },
        },
      },
      orderBy: [{ ticketId: "asc" }, { createdAt: "desc" }, { id: "desc" }],
      distinct: ["ticketId"],
      select: { ticketId: true, body: true },
    }),
    deps.prisma.run.findMany({
      where: { botId: { in: botIds }, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { botId: true },
    }),
  ]);

  const lastCommentByTicket = new Map<string, string>();
  for (const comment of lastComments) lastCommentByTicket.set(comment.ticketId, comment.body);
  const activeBotIds = new Set(activeRuns.map((run) => run.botId));
  const ticketsByBot = new Map<string, typeof tickets>();
  for (const ticket of tickets) {
    if (!ticket.assigneeBotId) continue;
    const list = ticketsByBot.get(ticket.assigneeBotId);
    if (list) list.push(ticket);
    else ticketsByBot.set(ticket.assigneeBotId, [ticket]);
  }

  const checkedBotIds: string[] = [];
  for (const bot of bots) {
    const botTickets = ticketsByBot.get(bot.id) ?? [];
    const decision = decideTicketWake({
      now,
      trigger: options.trigger,
      tickets: botTickets.map((ticket) => ({
        updatedAt: ticket.updatedAt,
        updatedByBot: ticket.updatedByBotId === bot.id,
        externalUpdatedAt: ticket.externalUpdatedAt,
      })),
      lastCheckAt: bot.ticketsCheckedAt,
      lastWakeAt: bot.ticketsWakeAt,
      hasActiveRun: activeBotIds.has(bot.id),
    });
    let advanceCheck = !decision.wake && keepsCheckedCursor(decision);
    if (decision.wake) {
      const board = botTickets[0]?.boardId
        ? await deps.prisma.board.findUnique({
            where: { id: botTickets[0]!.boardId },
            select: { ticketPrefix: true },
          })
        : null;
      const wakeTickets: TicketWakeTicket[] = botTickets.map((ticket) => ({
        id: ticket.id,
        ref: board ? `${board.ticketPrefix}-${ticket.number}` : `#${ticket.number}`,
        title: ticket.title,
        status: coerceTicketStatus(ticket.status),
        priority: coerceTicketPriority(ticket.priority),
        updatedAt: ticket.updatedAt,
        lastComment: lastCommentByTicket.get(ticket.id)?.trim() || null,
      }));
      const outcome = await startTicketWake(deps, {
        now,
        bot,
        boardId: botTickets[0]?.boardId ?? null,
        tickets: wakeTickets,
        reason: decision.reason,
      });
      // Only a wake this process started moves the cursor (a bot without a thread
      // can never wake, so it moves too). A lost claim or a busy abort leaves it so
      // the change is still visible later.
      advanceCheck = outcome === "started" || outcome === "skipped";
    }
    if (advanceCheck) checkedBotIds.push(bot.id);
  }

  if (checkedBotIds.length > 0) {
    await deps.prisma.bot.updateMany({
      where: { id: { in: checkedBotIds } },
      data: { ticketsCheckedAt: now },
    });
  }
}

/** Cursor moves only when nothing actionable is still waiting on this bot. */
function keepsCheckedCursor(decision: TicketWakeDecision): boolean {
  return decision.reason === "no-tickets" || decision.reason === "unchanged";
}

type TicketWakeStart = "started" | "fenced" | "busy" | "skipped";

async function startTicketWake(
  deps: TicketCheckDeps,
  input: {
    now: Date;
    bot: {
      id: string;
      spaceId: string;
      userId: string;
      name: string;
      thread: { id: string } | null;
    };
    boardId: string | null;
    tickets: TicketWakeTicket[];
    reason: "changed" | "reminder" | "assigned";
  },
): Promise<TicketWakeStart> {
  const threadId = input.bot.thread?.id;
  if (!threadId) return "skipped";

  const prompt = renderTicketWakePrompt({
    botName: input.bot.name,
    tickets: input.tickets,
    reason: input.reason,
  });
  const fence = new Date(input.now.getTime() - TICKET_WAKE_DEBOUNCE_MS);
  const outcome = await deps.prisma.$transaction(async (tx) => {
    const prior = await tx.bot.findUnique({
      where: { id: input.bot.id },
      select: { ticketsWakeAt: true },
    });
    const claimed = await tx.bot.updateMany({
      where: {
        id: input.bot.id,
        archivedAt: null,
        OR: [{ ticketsWakeAt: null }, { ticketsWakeAt: { lt: fence } }],
      },
      data: { ticketsWakeAt: input.now },
    });
    if (claimed.count === 0) return { kind: "fenced" as const };
    // A conversational run can land after the pre-check and before this claim.
    // Abort instead of queueing a second run, and put the fence back.
    const active = await tx.run.findFirst({
      where: { botId: input.bot.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true },
    });
    if (active) {
      await tx.bot.update({
        where: { id: input.bot.id },
        data: { ticketsWakeAt: prior?.ticketsWakeAt ?? null },
      });
      return { kind: "busy" as const };
    }
    const task = await tx.task.create({
      data: {
        spaceId: input.bot.spaceId,
        botId: input.bot.id,
        threadId,
        userId: input.bot.userId,
        prompt,
        status: "queued",
      },
    });
    const run = await tx.run.create({
      data: {
        spaceId: input.bot.spaceId,
        botId: input.bot.id,
        threadId,
        userId: input.bot.userId,
        taskId: task.id,
        status: "queued",
        trigger: "tickets",
      },
    });
    return { kind: "started" as const, runId: run.id };
  });
  if (outcome.kind !== "started") return outcome.kind;
  await deps.boardEvents
    ?.notify(input.bot.spaceId, input.boardId ? { boardId: input.boardId } : undefined)
    .catch(() => undefined);
  await deps.jobs.enqueue(runContinueJob(outcome.runId)).catch((error) => {
    getLogger().warn("ticket wake deferred to reconciliation", error);
  });
  return "started";
}

/**
 * Durable backstop for the periodic sweep: re-enqueue the sweep job when any
 * bot is overdue for a check. Judging by the stalest bot, not the freshest,
 * keeps frequent activity in one space from postponing everyone else's sweep.
 * The job is keyed, so repeated enqueues collapse into one.
 */
export async function reconcileTicketChecks(deps: TicketCheckDeps): Promise<void> {
  const overdue = await deps.prisma.bot.findFirst({
    where: {
      archivedAt: null,
      // A running bot cannot be woken. Leaving its cursor stale would schedule
      // another full sweep on every reconciler pass until that run ends.
      runs: { none: { status: { in: [...ACTIVE_RUN_STATUSES] } } },
      OR: [
        { ticketsCheckedAt: null },
        { ticketsCheckedAt: { lt: new Date(Date.now() - TICKET_CHECK_INTERVAL_MS) } },
      ],
    },
    select: { id: true },
  });
  if (!overdue) return;
  await deps.jobs.enqueue(ticketsCheckJob());
}
