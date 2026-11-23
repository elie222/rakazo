import type { MessageBlock } from "@rakazo/contracts";
import { parseTicketRef } from "@rakazo/contracts";
import { clampBotMessage } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  createTicketComment,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { runLeaseFor } from "../runs/assembly/run-messages.js";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";
import { wakeRun } from "../runs/wakeups/wake-run.js";
import { extractTicketRefs } from "../tasks/ticket-context.js";
import { createTicketAssigneeWakeRun } from "../tasks/ticket-wake.js";
import { commitBotMessageDelivery } from "./bot-message-commit.js";

/** The delivery dependencies shared by the chat and ticket paths. */
export type BotMessageDeliveryDeps = Pick<
  ExecutorDeps,
  "prisma" | "events" | "jobs" | "runLease" | "onTicketChange" | "deploymentLabs"
>;

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

/**
 * The ticket's assignee as of this transaction, read under the ticket row's lock —
 * the same lock `createTicketAssigneeWakeRun` takes — so a concurrent reassignment
 * serializes with the delivery: the assignee a route chose from is either still
 * true at commit, or the caller sees the new value here and re-routes.
 */
export async function ticketAssigneeUnderLock(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; ticketId: string },
): Promise<string | null | undefined> {
  await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${input.ticketId} FOR UPDATE`;
  const ticket = await tx.ticket.findFirst({
    where: { id: input.ticketId, spaceId: input.spaceId },
    select: { assigneeBotId: true },
  });
  return ticket?.assigneeBotId;
}

/** Record one side of a ticket-originated exchange on the ticket itself, like commentTicket. */
export async function recordTicketExchangeComment(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; ticketId: string; botId: string; body: string },
): Promise<void> {
  await createTicketComment(tx, {
    spaceId: input.spaceId,
    ticketId: input.ticketId,
    body: clampBotMessage(input.body),
    authorBotId: input.botId,
  });
}

/**
 * Deliver a ticket-originated result or status to its ticket instead of the requester's
 * chat: a comment on the ticket authored by the replying bot, plus a queued wake run for
 * the ticket's assignee so the ticket's work continues with the answer. Nothing is written
 * to or read from the requester's chat, and no chat run is started for it.
 *
 * The comment, the outcome claim and the assignee wake run commit in one transaction, so
 * a committed answer always carries its continuation with it: the wake's run row is the
 * durable record (a lost nudge is recovered like any other run), and the ticket row lock
 * inside makes the woken bot the assignee as of this commit, never a stale snapshot. A
 * missing `addressTo` (an archived requester) skips only the sender-thread echo — the
 * comment and the wake still land.
 *
 * Idempotency mirrors messageBot's: the sender-thread echo carries the delivery key as
 * its nonce, so a replay of the same tool call or outcome is detected (or loses on the
 * unique constraint), and a claimed terminal outcome replays rather than double-commenting.
 */
export async function deliverTicketBotMessageOutcome(
  deps: BotMessageDeliveryDeps,
  input: {
    run: {
      id: string;
      spaceId: string;
      threadId: string;
      botId: string;
      userId: string;
      /** The message that woke the sending run; its hop lineage continues through the wake. */
      sourceMessageId?: string | null;
    };
    sender: { id: string; name: string };
    /** Who the exchange is with, for the sender-thread echo record. */
    addressTo?: { id: string; name: string };
    ticketRef: string;
    /** The board and ticket the caller resolved with loadTicketForBotMessage. */
    ticket: { boardId: string; ticketId: string };
    text: string;
    intent: "result" | "status";
    /** Final nonce of the sender-thread echo; a probe hit means a prior attempt committed. */
    deliveryKey?: string;
    /**
     * How this delivery settles the run's terminal-outcome flag. `claim` marks it returned
     * in the same transaction as the comment; `suppressWhenClaimed` treats an already
     * claimed outcome as a replay, which keeps the automatic return from double-commenting
     * after the run sent its result explicitly.
     */
    outcome?: { claim: boolean; suppressWhenClaimed?: boolean };
    /**
     * When set, the delivery refuses to commit unless the ticket's locked assignee is
     * still this bot: a reassignment after the caller's routing read returns
     * `reassigned` with nothing committed, so the caller re-routes the reply instead
     * of settling its outcome on a route the requester no longer reads.
     */
    requireAssigneeBotId?: string;
    returnFrom?: "ended" | "waiting";
  },
): Promise<
  | { ok: true; ticketRef: string; senderEventSeq?: number; woken?: boolean }
  | { ok: true; replayed: true }
  | { ok: false; error: string; reassigned?: true }
> {
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

  const committed = await commitBotMessageDelivery<{
    ok: true;
    senderEventSeq?: number;
    wakeRunId?: string;
    woken: boolean;
  }>(
    deps,
    {
      run: input.run,
      returnFrom,
      lockThreadIds: [],
      nonce: input.deliveryKey
        ? { threadId: input.run.threadId, clientNonce: input.deliveryKey }
        : undefined,
    },
    async (tx) => {
      if (input.requireAssigneeBotId !== undefined) {
        const assignee = await ticketAssigneeUnderLock(tx, {
          spaceId: input.run.spaceId,
          ticketId: input.ticket.ticketId,
        });
        if (assignee !== input.requireAssigneeBotId) {
          return {
            ok: false as const,
            error: "the ticket was reassigned while sending",
            reassigned: true as const,
          };
        }
      }
      if (input.outcome?.suppressWhenClaimed || input.outcome?.claim) {
        const claimed = await tx.run.updateMany({
          where: { id: input.run.id, botOutcomeReturnedAt: null },
          data: { botOutcomeReturnedAt: new Date() },
        });
        // An explicit result claims silently; the automatic return treats an existing
        // claim as proof its outcome was already delivered.
        if (claimed.count === 0 && input.outcome?.suppressWhenClaimed)
          return { replayed: true as const };
      }
      // The continuation belongs to whoever owns the ticket at this commit; the sender
      // does not need waking for its own message. This runs first so the ticket row is
      // locked (and the wake run's thread referenced) before any comment write takes
      // locks on it, keeping this transaction's lock order sender-thread → ticket row.
      const wakeRunId = await createTicketAssigneeWakeRun(tx, {
        spaceId: input.run.spaceId,
        ticketId: input.ticket.ticketId,
        skipBotId: input.sender.id,
        deploymentLabs: deps.deploymentLabs,
        // The continuation inherits the chain the answering bot sat in, so the next
        // bot-to-bot message from the woken assignee continues the same bounded hop
        // count instead of restarting it.
        sourceMessageId: input.run.sourceMessageId ?? undefined,
      });
      // The ticket comment is the outcome's durable record and is unconditional: an
      // archived or missing requester must not drop it.
      await recordTicketExchangeComment(tx, {
        spaceId: input.run.spaceId,
        ticketId: input.ticket.ticketId,
        botId: input.sender.id,
        body: input.text,
      });
      let senderEventSeq: number | undefined;
      if (outboundBlock) {
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
        senderEventSeq = outboundEvent.seq;
      }
      return {
        ok: true as const,
        senderEventSeq,
        woken: Boolean(wakeRunId),
        ...(wakeRunId ? { wakeRunId } : {}),
      };
    },
  );
  if ("replayed" in committed) return { ok: true as const, replayed: true };
  if (!committed.ok) return committed;

  if (committed.senderEventSeq !== undefined) {
    await deps.events.notify(input.run.threadId, committed.senderEventSeq);
  }
  // Never rejects: the committed run row above is the durable record, and a lost nudge
  // is recovered like any other queued run's.
  if (committed.wakeRunId) await wakeRun(deps.jobs, committed.wakeRunId);
  // Board refresh only: the assignee wake itself was committed with the comment above,
  // so this failing cannot lose the continuation.
  await bestEffort(
    "bot message ticket board refresh",
    deps.onTicketChange?.({
      spaceId: input.run.spaceId,
      boardId: input.ticket.boardId,
      ticketId: input.ticket.ticketId,
      assigneeBotId: null,
      wakeAssignee: false,
    }),
  );
  return {
    ok: true as const,
    ticketRef: input.ticketRef,
    senderEventSeq: committed.senderEventSeq,
    woken: committed.woken,
  };
}
