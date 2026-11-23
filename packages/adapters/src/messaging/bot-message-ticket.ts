import type { MessageBlock } from "@rakazo/contracts";
import { parseTicketRef } from "@rakazo/contracts";
import { clampBotMessage } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  isUniqueViolation,
  spaceTakesWork,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { runLeaseFor } from "../runs/assembly/run-messages.js";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";
import { extractTicketRefs } from "../tasks/ticket-context.js";

/**
 * Ticket association for bot-to-bot exchanges that originate in ticket work. A ticket run
 * has no ticket column to carry: its task prompt names the ticket (`Work on ticket OPS-7`),
 * so the ref is recovered from there and then travels on the delivered
 * `bot_message_received` block (see messageBot), keeping the whole exchange — interim
 * questions included — bound to that ticket's workflow.
 */
export async function ticketRefForRun(
  prisma: PrismaClient,
  input: { spaceId: string; taskId?: string },
): Promise<string | undefined> {
  if (!input.taskId) return undefined;
  const task = await prisma.task.findUnique({
    where: { id: input.taskId },
    select: { prompt: true },
  });
  if (!task) return undefined;
  const board = await prisma.board.findUnique({
    where: { spaceId: input.spaceId },
    select: { ticketPrefix: true },
  });
  if (!board) return undefined;
  return extractTicketRefs(task.prompt, board.ticketPrefix)[0];
}

/** The board and ticket a bot-message ticket delivery targets, when they still exist. */
export async function loadTicketForBotMessage(
  prisma: PrismaClient,
  input: { spaceId: string; ticketRef: string },
): Promise<{ boardId: string; ticketId: string; assigneeBotId: string | null } | undefined> {
  const board = await prisma.board.findUnique({
    where: { spaceId: input.spaceId },
    select: { id: true, ticketPrefix: true },
  });
  if (!board) return undefined;
  const parsed = parseTicketRef(input.ticketRef, board.ticketPrefix);
  if (!parsed) return undefined;
  const ticket = await prisma.ticket.findFirst({
    where: { spaceId: input.spaceId, boardId: board.id, number: parsed.number },
    select: { id: true, assigneeBotId: true },
  });
  if (!ticket) return undefined;
  return { boardId: board.id, ticketId: ticket.id, assigneeBotId: ticket.assigneeBotId };
}

/** Record one side of a ticket-originated exchange on the ticket itself, like commentTicket. */
export async function recordTicketExchangeComment(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; ticketId: string; botId: string; body: string },
): Promise<void> {
  await tx.ticketComment.create({
    data: {
      ticketId: input.ticketId,
      spaceId: input.spaceId,
      authorBotId: input.botId,
      body: clampBotMessage(input.body),
    },
  });
  await tx.ticket.update({ where: { id: input.ticketId }, data: { updatedAt: new Date() } });
}

/**
 * Deliver a ticket-originated result or status to its ticket instead of the requester's
 * chat: a comment on the ticket authored by the replying bot, plus a wake for the current
 * assignee so the ticket's work continues with the answer. Nothing is written to or read
 * from the requester's chat, and no chat run is started for it.
 *
 * Idempotency mirrors messageBot's: the sender-thread echo carries the delivery key as its
 * nonce, so a replay of the same tool call or outcome is detected (or loses on the unique
 * constraint), and the auto outcome additionally claims `botOutcomeReturnedAt` inside the
 * same transaction that posts the comment.
 */
export async function deliverTicketBotMessageOutcome(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs" | "runLease" | "onTicketChange">,
  input: {
    run: { id: string; spaceId: string; threadId: string; botId: string; userId: string };
    sender: { id: string; name: string };
    /** Who the exchange is with, for the sender-thread echo record. */
    addressTo?: { id: string; name: string };
    ticketRef: string;
    text: string;
    intent: "result" | "status";
    deliveryKey?: string;
    /** The run's automatic final outcome: claim botOutcomeReturnedAt with the comment. */
    claimOutcome?: boolean;
    returnFrom?: "ended" | "waiting";
  },
): Promise<
  | { ok: true; ticketRef: string; senderEventSeq?: number }
  | { ok: true; replayed: true }
  | { ok: false; error: string; missingTicket?: true }
> {
  const ticket = await loadTicketForBotMessage(deps.prisma, {
    spaceId: input.run.spaceId,
    ticketRef: input.ticketRef,
  });
  if (!ticket)
    return {
      ok: false as const,
      error: `ticket ${input.ticketRef} is no longer available`,
      missingTicket: true as const,
    };

  const addressTo = input.addressTo;
  const outboundBlock: MessageBlock | undefined = addressTo
    ? {
        kind: "bot_message_sent",
        toBotId: addressTo.id,
        toBotName: addressTo.name,
        text: input.text,
        intent: input.intent,
      }
    : undefined;
  const returnFrom = input.returnFrom;
  const replayed = () => ({ ok: true as const, replayed: true as const });

  let committed:
    | { ok: true; senderEventSeq?: number }
    | { ok: false; error: string }
    | { ok: true; replayed: true };
  try {
    committed = await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        if (!(await spaceTakesWork(tx, input.run.spaceId)))
          return { ok: false as const, error: "this Space is being deleted" };
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.run.threadId} FOR UPDATE`;
        if (input.deliveryKey) {
          const already = await tx.message.findUnique({
            where: {
              threadId_clientNonce: {
                threadId: input.run.threadId,
                clientNonce: input.deliveryKey,
              },
            },
            select: { id: true },
          });
          if (already) return { ok: true as const, replayed: true as const };
        }
        const senderStillRunning = await tx.run.findFirst({
          where: {
            id: input.run.id,
            spaceId: input.run.spaceId,
            threadId: input.run.threadId,
            botId: input.run.botId,
            userId: input.run.userId,
            status:
              returnFrom === "ended"
                ? { in: ["completed", "failed", "cancelled"] }
                : returnFrom === "waiting"
                  ? "waiting_input"
                  : "running",
          },
          select: { id: true },
        });
        if (!senderStillRunning)
          return { ok: false as const, error: "source run is no longer active" };
        if (input.claimOutcome) {
          const claimed = await tx.run.updateMany({
            where: { id: input.run.id, botOutcomeReturnedAt: null },
            data: { botOutcomeReturnedAt: new Date() },
          });
          if (claimed.count === 0) return { ok: true as const, replayed: true as const };
        }
        if (!outboundBlock) return { ok: true as const, senderEventSeq: undefined };
        const outbound = await createThreadMessageInTransaction(tx, {
          threadId: input.run.threadId,
          role: "bot",
          blocks: [outboundBlock],
          botId: input.run.botId,
          runId: input.run.id,
          clientNonce: input.deliveryKey,
          markUnread: false,
          allowCancelledRun: returnFrom === "ended",
          lease: runLeaseFor(deps, input.run.id),
        });
        await recordTicketExchangeComment(tx, {
          spaceId: input.run.spaceId,
          ticketId: ticket.ticketId,
          botId: input.sender.id,
          body: input.text,
        });
        const outboundEvent = await appendEventInTransaction(tx, {
          spaceId: input.run.spaceId,
          threadId: input.run.threadId,
          botId: input.run.botId,
          type: "thread.message.created",
          runId: input.run.id,
          allowCancelledRun: returnFrom === "ended",
          lease: runLeaseFor(deps, input.run.id),
          payload: { messageId: outbound.id, role: "bot", blocks: [outboundBlock] },
        });
        return { ok: true as const, senderEventSeq: outboundEvent.seq };
      }, THREAD_LOCK_TRANSACTION_OPTIONS),
    );
  } catch (error) {
    if (input.deliveryKey && isUniqueViolation(error)) {
      const winner = await deps.prisma.message.findUnique({
        where: {
          threadId_clientNonce: { threadId: input.run.threadId, clientNonce: input.deliveryKey },
        },
        select: { id: true },
      });
      if (winner) return replayed();
    }
    throw error;
  }
  if ("replayed" in committed) return replayed();
  if (!committed.ok) return committed;

  if (committed.senderEventSeq !== undefined) {
    await deps.events.notify(input.run.threadId, committed.senderEventSeq);
  }
  await deps
    .onTicketChange?.({
      spaceId: input.run.spaceId,
      boardId: ticket.boardId,
      ticketId: ticket.ticketId,
      assigneeBotId: ticket.assigneeBotId,
      // The answer only moves the work forward for whoever now owns the ticket.
      wakeAssignee: Boolean(ticket.assigneeBotId) && ticket.assigneeBotId !== input.sender.id,
    })
    .catch((error) => getLogger().error("bot message ticket delivery wake failed", error));
  return {
    ok: true as const,
    ticketRef: input.ticketRef,
    senderEventSeq: committed.senderEventSeq,
  };
}
