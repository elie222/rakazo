import type { BotMessageIntent, MessageBlock } from "@rakazo/contracts";
import type { BotMessageContext } from "@rakazo/core";
import {
  BOT_MESSAGE_MAX_LENGTH,
  BOT_MESSAGE_TOO_LONG,
  botMessageContext,
  botMessageHopExhausted,
  botMessageWaitingText,
  buildBotMessageWakePrompt,
  clampBotMessage,
  nextBotMessageHop,
  resolveBotAddress,
  retry,
  sanitizeMessagingLabel,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  readMessageBlocks,
  storedMessageBlocks,
} from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import { runLeaseFor } from "../runs/assembly/run-messages.js";
import { wakeRun } from "../runs/wakeups/wake-run.js";
import { commitBotMessageDelivery } from "./bot-message-commit.js";
import type { BotMessageDeliveryDeps } from "./bot-message-ticket.js";
import {
  deliverTicketBotMessageOutcome,
  loadTicketForBotMessage,
  recordTicketExchangeComment,
  ticketAssigneeUnderLock,
  ticketRefForRun,
} from "./bot-message-ticket.js";

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
  const blocks = source ? storedMessageBlocks({ id: sourceMessageId, blocks: source.blocks }) : [];
  return botMessageContext(blocks)?.hop ?? 0;
}

/**
 * The context a bot-message source carries, or — when its row exists but lost
 * entries — a marker that says so. The marker's fields read as absent so every
 * optional-chained consumer treats it as an unparseable source, while
 * `blocksIntact: false` lets a deciding reader take the restrictive answer.
 */
export type LoadedBotMessageContext =
  | (BotMessageContext & { repliesToRequest: boolean; blocksIntact: boolean })
  | {
      blocksIntact: false;
      kind?: undefined;
      fromBotId?: undefined;
      fromBotName?: undefined;
      text?: undefined;
      intent?: undefined;
      hop?: undefined;
      ticketRef?: undefined;
      repliesToRequest?: undefined;
    };

export async function loadBotMessageContext(
  prisma: PrismaClient,
  sourceMessageId: string | null | undefined,
): Promise<LoadedBotMessageContext | undefined> {
  if (!sourceMessageId) return undefined;
  const source = await prisma.message.findUnique({
    where: { id: sourceMessageId },
    select: { blocks: true, replyTo: { select: { id: true, blocks: true } } },
  });
  if (!source) return undefined;
  const stored = readMessageBlocks({ id: sourceMessageId, blocks: source.blocks });
  const context = botMessageContext(stored.blocks);
  // A row that lost entries may have lost the ticket tag or the whole exchange
  // marker: readers that decide from this context get the restrictive answer
  // through `blocksIntact`, so the marker is returned instead of nothing.
  if (!context) return stored.intact ? undefined : { blocksIntact: false };
  const replyBlocks = source.replyTo ? storedMessageBlocks(source.replyTo) : [];
  const repliesToRequest =
    (context.intent === "result" || context.intent === "status" || context.intent === "fyi") &&
    replyBlocks.some(
      (block) =>
        block.kind === "bot_message_sent" &&
        block.toBotId === context.fromBotId &&
        (block.intent === undefined || block.intent === "request" || block.intent === "question"),
    );
  return { ...context, repliesToRequest, blocksIntact: stored.intact };
}

/** Bots named in a resolution error; a large Space must not turn one tool result into a wall. */
const REACHABLE_BOTS_MAX = 12;

/**
 * Attempts to land an ownership-sensitive send on a route the ticket's assignment
 * still supports. Each invalidated attempt commits nothing, so one re-route per
 * changing assignment is enough in practice; past this the model is told to send
 * again rather than looping over a ticket that keeps changing hands.
 */
const ROUTE_ATTEMPTS = 3;

/** A delivery whose selected route the ticket's locked assignment no longer supports. */
class RouteReassigned extends Error {
  constructor(ticketRef: string) {
    super(`ticket ${ticketRef} kept being reassigned while sending; try again`);
  }
}

/**
 * The ticket a result or status from this run reports on, and its current assignee —
 * the route decision `messageBot` makes, factored out so the `message_bot` tool can
 * refuse an attachment such a send cannot deliver before saving copies for it.
 * `messageBot` re-reads the route per attempt and validates it at commit.
 */
export async function ticketOutcomeRoute(
  prisma: PrismaClient,
  run: { spaceId: string; taskId?: string; trigger?: string; sourceMessageId?: string | null },
): Promise<{ ticketRef: string; assigneeBotId: string | null } | undefined> {
  const sourceContext = await loadBotMessageContext(prisma, run.sourceMessageId);
  const ticketOrigin =
    sourceContext?.ticketRef ??
    (run.trigger === "tickets" ? await ticketRefForRun(prisma, run) : undefined);
  if (!ticketOrigin) return undefined;
  const ticket = await loadTicketForBotMessage(prisma, {
    spaceId: run.spaceId,
    ticketRef: ticketOrigin,
  });
  if (!ticket) return undefined;
  return { ticketRef: ticketOrigin, assigneeBotId: ticket.assigneeBotId };
}

/**
 * What a failed lookup could have used instead. The candidates are already loaded for the
 * lookup, and a bare "no bot found" leaves a weaker model retrying the same name or reporting
 * the tool broken. Bots without a chat cannot be delivered to, and a bot cannot message
 * itself, so neither is offered.
 */
export function unresolvedBotError(
  candidates: readonly { id: string; name: string; thread: unknown }[],
  senderId: string,
): string {
  const reachable = candidates.filter((bot) => bot.id !== senderId && bot.thread);
  if (reachable.length === 0) {
    return "no bot found with that id or name. No other bot in this space has a chat to message";
  }
  const listed = reachable
    .slice(0, REACHABLE_BOTS_MAX)
    .map((bot) => `${sanitizeMessagingLabel(bot.name)} (${bot.id})`);
  const hidden = reachable.length - listed.length;
  return `no bot found with that id or name. Bots reachable from this space (use bot_id): ${listed.join("; ")}${
    hidden > 0 ? `; and ${hidden} more` : ""
  }`;
}

export async function messageBot(
  deps: BotMessageDeliveryDeps,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
    /** Present for runs the executor starts; a `tickets` trigger marks ticket origin. */
    trigger?: string;
    taskId?: string;
  },
  sender: { id: string; name: string },
  input: {
    bot_id?: string;
    confirm_name?: string;
    message: string;
    intent?: BotMessageIntent;
    deliveryKey?: string;
    /** Attachments filed under the recipient's chat, shown there and copied to its computer. */
    files?: Array<Extract<MessageBlock, { kind: "image" | "file" }>>;
  },
  /** `ended` or `waiting` sends a return to the requester from a run that is no longer running. */
  options?: { returnFrom?: "ended" | "waiting"; forceUnread?: boolean },
) {
  const message = String(input.message ?? "").trim();
  if (!message) return { ok: false as const, error: "message is required" };
  if (message.length > BOT_MESSAGE_MAX_LENGTH) {
    return { ok: false as const, error: BOT_MESSAGE_TOO_LONG };
  }

  const sourceContext = await loadBotMessageContext(deps.prisma, run.sourceMessageId);
  const intent = input.intent ?? "request";
  const hop = nextBotMessageHop(sourceContext?.hop);

  const candidates = await deps.prisma.bot.findMany({
    where: { spaceId: run.spaceId, archivedAt: null },
    select: { id: true, name: true, thread: { select: { id: true } } },
  });
  const target = resolveBotAddress(candidates, {
    botId: input.bot_id,
    name: input.confirm_name,
  });
  if (!target) {
    return { ok: false as const, error: unresolvedBotError(candidates, sender.id) };
  }
  if (target.id === sender.id) return { ok: false as const, error: "a bot cannot message itself" };
  if (!target.thread)
    return { ok: false as const, error: `${target.name} has no chat to deliver to` };
  const returnFrom = options?.returnFrom;
  const returnsToSender =
    returnFrom !== undefined &&
    (intent === "result" || intent === "status") &&
    (sourceContext?.intent === undefined ||
      sourceContext.intent === "request" ||
      sourceContext.intent === "question") &&
    sourceContext?.fromBotId === target.id;

  // Ticket origin: a send from a ticket-triggered run, or one already working such an
  // exchange (the inbound block carries the ref through the chain). The ticket is part of
  // every such delivery: a result or status for the ticket's current assignee belongs on
  // the ticket itself, while requests, questions and FYIs — and results for any other
  // bot, such as the helper that asked — are delivered as ordinary bot messages that stay
  // marked with the ticket. A tag whose ticket no longer resolves is an error, not a
  // silent drop: the recipient must not start work whose answer can never land anywhere.
  const ticketOrigin =
    sourceContext?.ticketRef ??
    (run.trigger === "tickets" ? await ticketRefForRun(deps.prisma, run) : undefined);
  const files = input.files ?? [];
  const ticket = ticketOrigin
    ? await loadTicketForBotMessage(deps.prisma, {
        spaceId: run.spaceId,
        ticketRef: ticketOrigin,
      })
    : undefined;
  if (ticketOrigin && !ticket) {
    return {
      ok: false as const,
      error: `ticket ${ticketOrigin} is no longer available`,
      missingTicket: true as const,
    };
  }
  if (botMessageHopExhausted(hop) && !returnsToSender) {
    return {
      ok: false as const,
      error: ticketOrigin
        ? "bot-to-bot message limit reached for this ticket's collaboration; record the outcome on the ticket instead of messaging another bot"
        : "bot-to-bot message limit reached for this chain; report back to the user instead of messaging another bot",
    };
  }

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

  // A reply serving the bot that handed this run its request or question.
  const repliesToItsRequester =
    sourceContext?.fromBotId === target.id &&
    (sourceContext.intent === undefined ||
      sourceContext.intent === "request" ||
      sourceContext.intent === "question");
  const wakePrompt = buildBotMessageWakePrompt({
    from: sender,
    text: message,
    intent,
    ...(ticketOrigin ? { ticketRef: ticketOrigin } : {}),
  });
  const outboundBlock: MessageBlock = {
    kind: "bot_message_sent",
    toBotId: target.id,
    toBotName: target.name,
    text: message,
    intent,
  };

  // A result or status the ticket's current assignee will read is ownership-sensitive:
  // the route is chosen from an assignee read that can go stale before the delivery
  // transaction commits. Each attempt re-validates the assignment under the ticket
  // row's lock inside the transaction — rejecting with `reassigned` and committing
  // nothing when it changed — so the send re-routes from a fresh read and the
  // addressed requester gets its reply on the route its role supports; once the
  // attempts run out the model is told to send again over a ticket that keeps
  // changing hands. A send carrying attachment blocks never takes the ticket-only
  // route (a comment cannot carry them) and is never re-routed onto it, so prepared
  // files always travel the chat path that delivers them.
  const sent = await retry(
    async () => {
      const attemptTicket = ticketOrigin
        ? await loadTicketForBotMessage(deps.prisma, {
            spaceId: run.spaceId,
            ticketRef: ticketOrigin,
          })
        : undefined;
      if (ticketOrigin && !attemptTicket) {
        return {
          ok: false as const,
          error: `ticket ${ticketOrigin} is no longer available`,
          missingTicket: true as const,
        };
      }
      if (
        ticketOrigin &&
        attemptTicket &&
        files.length === 0 &&
        (intent === "result" || intent === "status") &&
        attemptTicket.assigneeBotId === target.id
      ) {
        const outcome = await deliverTicketBotMessageOutcome(deps, {
          run,
          sender,
          addressTo: { id: target.id, name: target.name },
          ticketRef: ticketOrigin,
          ticket: attemptTicket,
          text: message,
          intent,
          deliveryKey,
          // An explicit terminal result settles the run's outcome here, so the automatic
          // return after completion replays instead of double-commenting; interim statuses
          // and results to anyone else stay eligible for the automatic return.
          ...(intent === "result" && repliesToItsRequester ? { outcome: { claim: true } } : {}),
          returnFrom,
          requireAssigneeBotId: target.id,
        });
        if (!outcome.ok) {
          if (!outcome.reassigned) return outcome;
          throw new RouteReassigned(ticketOrigin);
        }
        if ("replayed" in outcome) {
          return {
            ok: true as const,
            botId: target.id,
            name: target.name,
            delivered: message,
            replayed: true as const,
            note: `Already recorded on ticket ${ticketOrigin}; it was not recorded again.`,
          };
        }
        return {
          ok: true as const,
          botId: target.id,
          name: target.name,
          delivered: message,
          // Claim the wake only when a continuation run was actually committed (the
          // assignee may be missing, archived, or ineligible for the board).
          note: `Recorded as a comment on ticket ${ticketOrigin}.${
            outcome.woken
              ? " The ticket's assignee is woken to continue that work; nothing was sent to anyone's chat."
              : ""
          }`,
        };
      }

      const committed = await commitBotMessageDelivery<{
        ok: true;
        runId: string;
        targetEventSeq: number;
        senderEventSeq: number;
      }>(
        deps,
        {
          run,
          returnFrom,
          lockThreadIds: [targetThreadId],
          nonce: deliveryKey ? { threadId: targetThreadId, clientNonce: deliveryKey } : undefined,
          target: { id: target.id, name: target.name },
        },
        async (tx) => {
          if (
            ticketOrigin &&
            attemptTicket &&
            files.length === 0 &&
            (intent === "result" || intent === "status")
          ) {
            const assignee = await ticketAssigneeUnderLock(tx, {
              spaceId: run.spaceId,
              ticketId: attemptTicket.ticketId,
            });
            if (assignee === target.id) throw new RouteReassigned(ticketOrigin);
          }
          // Echo into the sender's chat in the same transaction so a failed notify
          // cannot leave one side delivered and the other blank. The echo also
          // carries the delivery key, making the sender's thread a stamp domain
          // both routes share (see the probe in commitBotMessageDelivery).
          const outbound = await createThreadMessageInTransaction(tx, {
            threadId: run.threadId,
            role: "bot",
            blocks: [outboundBlock],
            botId: run.botId,
            runId: run.id,
            ...(deliveryKey ? { clientNonce: deliveryKey } : {}),
            markUnread: options?.forceUnread === true && !ticketOrigin,
            allowCancelledRun: returnFrom === "ended",
            lease: runLeaseFor(deps, run.id),
          });
          const inboundBlock: MessageBlock = {
            kind: "bot_message_received",
            fromBotId: sender.id,
            fromBotName: sender.name,
            text: message,
            hop,
            intent,
            returnToMessageId: outbound.id,
            ...(ticketOrigin ? { ticketRef: ticketOrigin } : {}),
          };
          const inbound = await createThreadMessageInTransaction(tx, {
            threadId: targetThreadId,
            role: "user",
            blocks: [inboundBlock, ...files],
            replyToMessageId:
              sourceContext?.fromBotId === target.id && intent !== "fyi"
                ? sourceContext.returnToMessageId
                : undefined,
            clientNonce: deliveryKey,
            markUnread: options?.forceUnread === true && !ticketOrigin,
          });
          if (attemptTicket) {
            // This side of a ticket-originated exchange, kept on the ticket itself: the
            // reply is recorded there too (see deliverTicketBotMessageOutcome), so the
            // workflow stays readable without any owner's chat.
            await recordTicketExchangeComment(tx, {
              spaceId: run.spaceId,
              ticketId: attemptTicket.ticketId,
              botId: sender.id,
              body: message,
            });
          }
          const task = await tx.task.create({
            data: {
              spaceId: run.spaceId,
              botId: target.id,
              threadId: targetThreadId,
              userId: run.userId,
              prompt: wakePrompt,
              status: "queued",
            },
          });
          const nextRun = await tx.run.create({
            data: {
              spaceId: run.spaceId,
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
            spaceId: run.spaceId,
            threadId: targetThreadId,
            botId: target.id,
            type: "thread.message.created",
            runId: nextRun.id,
            payload: { messageId: inbound.id, role: "user", blocks: [inboundBlock, ...files] },
          });
          const outboundEvent = await appendEventInTransaction(tx, {
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            type: "thread.message.created",
            runId: run.id,
            allowCancelledRun: returnFrom === "ended",
            lease: runLeaseFor(deps, run.id),
            payload: { messageId: outbound.id, role: "bot", blocks: [outboundBlock] },
          });
          return {
            ok: true as const,
            runId: nextRun.id,
            targetEventSeq: inboundEvent.seq,
            senderEventSeq: outboundEvent.seq,
          };
        },
      );
      if ("replayed" in committed) return replayed();
      if (!committed.ok) return committed;

      await deps.events.notify(targetThreadId, committed.targetEventSeq);
      await deps.events.notify(run.threadId, committed.senderEventSeq);
      await wakeRun(deps.jobs, committed.runId);
      if (attemptTicket) {
        // Board refresh only: the comment above is the durable record and the
        // recipient's wake was committed with it, so a lost nudge loses nothing —
        // the same best-effort shape the ticket outcome path uses.
        await bestEffort(
          "bot message ticket board refresh",
          deps.onTicketChange?.({
            spaceId: run.spaceId,
            boardId: attemptTicket.boardId,
            ticketId: attemptTicket.ticketId,
            assigneeBotId: null,
            wakeAssignee: false,
          }),
        );
      }
      return {
        ok: true as const,
        botId: target.id,
        name: target.name,
        delivered: message,
        note: ticketOrigin
          ? `Sent to ${target.name}. Delivery is async; a reply wakes you later as a new message. The exchange is recorded on ticket ${ticketOrigin}. Continue independent work; send another update later only if it adds something new.`
          : `Sent to ${target.name}. Delivery is async; a reply wakes you later as a new message. Continue independent work; send another update later only if it adds something new.`,
      };
    },
    {
      attempts: ROUTE_ATTEMPTS,
      delayMs: 0,
      retryable: (error) => error instanceof RouteReassigned,
    },
  ).catch((error) =>
    error instanceof RouteReassigned
      ? { ok: false as const, error: error.message }
      : Promise.reject(error),
  );
  return sent;
}

type DelegatedRun = {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  sourceMessageId?: string | null;
};

/** The bot that handed this run its request or question, while it can still take a reply. */
async function requesterBot(
  prisma: PrismaClient,
  run: DelegatedRun,
  source?: Awaited<ReturnType<typeof loadBotMessageContext>>,
): Promise<{ id: string; name: string } | undefined> {
  const context = source ?? (await loadBotMessageContext(prisma, run.sourceMessageId));
  // A context without a sender (a source row that lost its entries) names no
  // requester to resolve: the outcome then belongs on the ticket, not on
  // whatever bot happens to sort first.
  if (!context?.fromBotId) return undefined;
  const sourceIntent = context.intent ?? "request";
  if (sourceIntent !== "request" && sourceIntent !== "question") return undefined;
  // messageBot reaches only active bots of this space, so an archived or deleted
  // requester can never take the reply.
  const requester = await prisma.bot.findFirst({
    where: { id: context.fromBotId, spaceId: run.spaceId, archivedAt: null },
    select: { id: true, name: true },
  });
  return requester ?? undefined;
}

/** Whether the run already sent this bot an explicit terminal result. */
async function sentResultToBot(
  prisma: PrismaClient,
  run: DelegatedRun,
  botId: string,
): Promise<boolean> {
  const sent = await prisma.message.findMany({
    where: { threadId: run.threadId, runId: run.id },
    select: { id: true, blocks: true },
  });
  return sent.some((message) =>
    storedMessageBlocks(message).some(
      (block) =>
        block.kind === "bot_message_sent" && block.toBotId === botId && block.intent === "result",
    ),
  );
}

/** Return a delegated run's terminal outcome unless it already sent one explicitly. */
export async function returnBotMessageOutcome(
  deps: BotMessageDeliveryDeps,
  run: DelegatedRun,
  sender: { id: string; name: string },
  text: string,
  intent: "result" | "status" = "result",
  options?: { forceUnread?: boolean },
) {
  const source = await loadBotMessageContext(deps.prisma, run.sourceMessageId);
  const requester = await requesterBot(deps.prisma, run, source);
  // Distinguish "nothing to answer" from "cannot answer". An fyi, result or status
  // source never solicited a reply, so its completion text is not an outcome to route
  // anywhere — posting it to the ticket would turn every acknowledgment into a new
  // continuation. A request or question whose requester went away is different: that
  // outcome still belongs on the ticket, where its assignee picks it up.
  const sourceSolicitedReply =
    !source ||
    source.intent === undefined ||
    source.intent === "request" ||
    source.intent === "question";
  if (source?.ticketRef) {
    // A ticket-originated clarification: the outcome belongs on that ticket's workflow,
    // not in any owner's chat. The claim inside the delivery transaction makes the
    // return exactly-once, replay-safe the same way the chat path's key is.
    const ticket = await loadTicketForBotMessage(deps.prisma, {
      spaceId: run.spaceId,
      ticketRef: source.ticketRef,
    });
    if (!ticket) {
      // A ticket that no longer exists makes the outcome moot, not retryable.
      getLogger().warn("bot message ticket outcome dropped", {
        error: `ticket ${source.ticketRef} is no longer available`,
      });
      await markBotOutcomeReturned(deps.prisma, run.id);
      return true;
    }
    if (sourceSolicitedReply && (!requester || ticket.assigneeBotId === requester.id)) {
      // An explicit result this run already sent the asking bot settles the
      // outcome even when it took the chat path, which claims nothing: a later
      // reassignment or archival must not re-deliver that answer as a second
      // ticket comment and assignee wake.
      if (source.fromBotId && (await sentResultToBot(deps.prisma, run, source.fromBotId))) {
        await markBotOutcomeReturned(deps.prisma, run.id);
        return true;
      }
      // The asking bot still owns the ticket — or is archived and can no longer take a
      // reply: either way the outcome lands on the ticket as a comment that wakes its
      // current assignee. Only the sender-thread echo needs a requester to address.
      // While it owns the ticket, the delivery holds it to that read: a reassignment
      // that commits underneath returns `reassigned` with nothing written, and the
      // still-active requester takes its answer as an ordinary ticket-tagged reply
      // below instead of losing it to the flip.
      const outcome = await deliverTicketBotMessageOutcome(deps, {
        run,
        sender,
        ...(requester ? { addressTo: requester, requireAssigneeBotId: requester.id } : {}),
        ticketRef: source.ticketRef,
        ticket,
        text: clampBotMessage(text),
        intent,
        deliveryKey: `bot-message:auto-outcome:${run.id}`,
        outcome: { claim: true, suppressWhenClaimed: true },
        returnFrom: "ended",
      });
      if (outcome.ok) {
        await markBotOutcomeReturned(deps.prisma, run.id);
        return true;
      }
      if (!outcome.reassigned) return false;
    }
    // The asking bot no longer owns the ticket (a helper-to-helper chain, or the ticket
    // was reassigned): the answer goes to it below as an ordinary bot message, which
    // still records the exchange on the ticket and never routes an obsolete assignee's
    // continuation through the wake.
  }
  const requesterId = requester?.id;
  if (!requesterId) {
    await markBotOutcomeReturned(deps.prisma, run.id);
    // Handled: nothing to deliver. Return true so callers do not release a reservation.
    return true;
  }
  // Only an explicit result counts as a terminal outcome. Interim message_bot
  // status updates must not suppress the automatic final return.
  const alreadyReturned = await sentResultToBot(deps.prisma, run, requesterId);
  if (alreadyReturned) {
    await markBotOutcomeReturned(deps.prisma, run.id);
    return true;
  }
  const outcome = await messageBot(
    deps,
    run,
    sender,
    {
      bot_id: requesterId,
      message: clampBotMessage(text),
      intent,
      // One key per run so status vs result (executor vs reconciler) cannot double-deliver.
      deliveryKey: `auto-outcome:${run.id}`,
    },
    { returnFrom: "ended", forceUnread: options?.forceUnread },
  );
  if (outcome.ok) await markBotOutcomeReturned(deps.prisma, run.id);
  return outcome.ok;
}

/**
 * Tell the requester a delegated run is waiting on the user, so it can say so instead of
 * hearing nothing until the user answers. `waitId` is the paused attempt: one notice per wait.
 */
export async function reportBotMessageWait(
  deps: BotMessageDeliveryDeps,
  run: DelegatedRun & { trigger: string },
  sender: { id: string; name: string },
  ask: string,
  waitId: string,
) {
  if (run.trigger !== "bot_message") return;
  // The delivery key makes a repeat a replay, so any failure is worth another try.
  await bestEffort(
    "bot message wait notice",
    retry(() => sendWaitNotice(deps, run, sender, ask, waitId), {
      attempts: 3,
      retryable: () => true,
    }),
  );
}

async function sendWaitNotice(
  deps: BotMessageDeliveryDeps,
  run: DelegatedRun,
  sender: { id: string; name: string },
  ask: string,
  waitId: string,
) {
  const requesterId = (await requesterBot(deps.prisma, run))?.id;
  if (!requesterId) return;
  const sent = await messageBot(
    deps,
    run,
    sender,
    {
      bot_id: requesterId,
      message: clampBotMessage(botMessageWaitingText(ask)),
      intent: "status",
      deliveryKey: `waiting:${waitId}`,
    },
    { returnFrom: "waiting", forceUnread: true },
  );
  if (!sent.ok) getLogger().warn("bot message wait notice not sent", { error: sent.error });
}

async function markBotOutcomeReturned(prisma: PrismaClient, runId: string) {
  await prisma.run.updateMany({
    where: {
      id: runId,
      status: { in: ["completed", "failed", "cancelled"] },
      botOutcomeReturnedAt: null,
    },
    data: { botOutcomeReturnedAt: new Date() },
  });
}
