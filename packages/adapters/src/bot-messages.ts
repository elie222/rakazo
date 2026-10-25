import { runContinueJob } from "@rakazo/adapter-kit";
import type { BotMessageIntent, MessageBlock } from "@rakazo/contracts";
import {
  BOT_MESSAGE_MAX_LENGTH,
  botMessageContext,
  botMessageHopExhausted,
  buildBotMessageWakePrompt,
  clampBotMessage,
  nextBotMessageHop,
  resolveBotAddress,
} from "@rakazo/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
  lockOwnedGroup,
  type PrismaClient,
  touchGroupUpdatedAt,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
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
  return botMessageContext(blocks)?.hop ?? 0;
}

export async function loadBotMessageContext(
  prisma: PrismaClient,
  sourceMessageId: string | null | undefined,
) {
  if (!sourceMessageId) return undefined;
  const source = await prisma.message.findUnique({
    where: { id: sourceMessageId },
    select: { blocks: true, replyTo: { select: { blocks: true } } },
  });
  const context = botMessageContext(
    Array.isArray(source?.blocks) ? (source.blocks as MessageBlock[]) : [],
  );
  if (!context) return undefined;
  const replyBlocks = Array.isArray(source?.replyTo?.blocks)
    ? (source.replyTo.blocks as MessageBlock[])
    : [];
  const repliesToRequest =
    (context.intent === "result" || context.intent === "status" || context.intent === "fyi") &&
    replyBlocks.some(
      (block) =>
        block.kind === "bot_message_sent" &&
        block.toBotId === context.fromBotId &&
        (block.intent === undefined || block.intent === "request" || block.intent === "question"),
    );
  return { ...context, repliesToRequest };
}

export async function messageBot(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
  },
  sender: { id: string; name: string },
  input: {
    bot_id?: string;
    confirm_name?: string;
    message: string;
    intent?: BotMessageIntent;
    deliveryKey?: string;
  },
  options?: { allowTerminalSource?: boolean; forceUnread?: boolean },
) {
  const message = String(input.message ?? "").trim();
  if (!message) return { ok: false as const, error: "message is required" };
  if (message.length > BOT_MESSAGE_MAX_LENGTH) {
    return {
      ok: false as const,
      error: `message exceeds the ${BOT_MESSAGE_MAX_LENGTH} character limit`,
    };
  }

  const sourceContext = await loadBotMessageContext(deps.prisma, run.sourceMessageId);
  const intent = input.intent ?? "request";
  const hop = nextBotMessageHop(sourceContext?.hop);

  const candidates = await deps.prisma.bot.findMany({
    where: { spaceId: run.spaceId, userId: run.userId, archivedAt: null },
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
  // This run is answering the target's own request or question.
  const answersTarget =
    sourceContext?.fromBotId === target.id &&
    (sourceContext.intent === undefined ||
      sourceContext.intent === "request" ||
      sourceContext.intent === "question");
  const returnsToSender =
    options?.allowTerminalSource === true &&
    (intent === "result" || intent === "status") &&
    answersTarget;
  if (botMessageHopExhausted(hop) && !returnsToSender) {
    return {
      ok: false as const,
      error:
        "bot-to-bot message limit reached for this chain; report back to the user instead of messaging another bot",
    };
  }

  const targetThreadId = target.thread.id;
  // Teammates that share exactly one group coordinate there, where the user can
  // see it. An answer to the target's own request still goes back to its chat.
  const group =
    options?.allowTerminalSource || answersTarget
      ? undefined
      : await sharedGroup(deps.prisma, run, sender.id, target.id);
  const replyCandidate =
    sourceContext?.fromBotId === target.id && intent !== "fyi"
      ? sourceContext.returnToMessageId
      : undefined;
  const deliveryThreadId = group?.threadId ?? targetThreadId;

  // A tool call can be re-executed after a lease expiry, so a delivery has to be
  // replayable: without this the recipient is messaged twice and woken twice.
  const deliveryKey = input.deliveryKey ? `bot-message:${input.deliveryKey}` : undefined;
  // The destination can change between attempts (a group archived or joined), so a
  // replay is recognised by the sender's echo, which always lands in the sender's chat.
  // Deliveries recorded before the echo carried the key are found in the target's chats.
  const sentNonce = deliveryKey ? `${deliveryKey}:sent` : undefined;
  const replayThreadIds = [...new Set([targetThreadId, deliveryThreadId])];
  const deliveryRecords = deliveryKey
    ? [
        { threadId: run.threadId, clientNonce: sentNonce! },
        ...replayThreadIds.map((threadId) => ({ threadId, clientNonce: deliveryKey })),
      ]
    : [];
  const replayed = () =>
    ({
      ok: true as const,
      botId: target.id,
      name: target.name,
      delivered: message,
      replayed: true as const,
      note: `Already sent to ${target.name} in this turn; it was not sent again.`,
    }) as const;

  const wakePrompt = buildBotMessageWakePrompt({
    from: sender,
    text: message,
    intent,
    groupName: group?.name,
  });
  const outboundBlock: MessageBlock = {
    kind: "bot_message_sent",
    toBotId: target.id,
    toBotName: target.name,
    text: message,
    intent,
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
    committed = await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        if (group) {
          try {
            await lockOwnedGroup(tx, run, group.id);
          } catch (error) {
            if (error instanceof IsolationError)
              return { ok: false as const, error: "group is no longer available; try again" };
            throw error;
          }
        }
        for (const threadId of [...new Set([run.threadId, ...replayThreadIds])].sort()) {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
        }
        // Claim the delivery key inside the transaction so a concurrent retry
        // either sees the winner or loses on the unique (threadId, clientNonce).
        if (deliveryKey) {
          if (await findDelivery(tx, deliveryRecords))
            return { ok: true as const, replayed: true as const };
        }

        const senderStillRunning = await tx.run.findFirst({
          where: {
            id: run.id,
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            userId: run.userId,
            status: options?.allowTerminalSource
              ? { in: ["completed", "failed", "cancelled"] }
              : "running",
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
            spaceId: run.spaceId,
            userId: run.userId,
            archivedAt: null,
          },
          select: { id: true },
        });
        if (!stillAddressable)
          return { ok: false as const, error: `${target.name} is no longer available` };
        if (group && !(await sharesGroup(tx, run, group.id, sender.id, target.id)))
          return { ok: false as const, error: "group members changed; try again" };

        // Echo into the sender's chat in the same transaction so a failed notify
        // cannot leave one side delivered and the other blank.
        const outbound = await createThreadMessageInTransaction(tx, {
          threadId: run.threadId,
          role: "bot",
          blocks: [outboundBlock],
          botId: run.botId,
          runId: run.id,
          clientNonce: sentNonce,
          markUnread: options?.forceUnread === true,
          allowCancelledRun: options?.allowTerminalSource === true,
        });
        // In a group the message is the sender's visible handoff line. It is not
        // tied to the sender's run, which lives in another chat.
        const inboundBlock: MessageBlock = group
          ? {
              kind: "handoff",
              fromBotId: sender.id,
              toBotId: target.id,
              text: message,
              hop,
              fromBotName: sender.name,
              intent,
              returnToMessageId: outbound.id,
            }
          : {
              kind: "bot_message_received",
              fromBotId: sender.id,
              fromBotName: sender.name,
              text: message,
              hop,
              intent,
              returnToMessageId: outbound.id,
            };
        // An answer keeps its link to the request. Any other reply link must point
        // into the chat this message is written to, which can now be a group.
        const replyToMessageId =
          replyCandidate && !answersTarget
            ? (
                await tx.message.findFirst({
                  where: { id: replyCandidate, threadId: deliveryThreadId },
                  select: { id: true },
                })
              )?.id
            : replyCandidate;
        const inbound = await createThreadMessageInTransaction(tx, {
          threadId: deliveryThreadId,
          role: group ? "bot" : "user",
          blocks: [inboundBlock],
          botId: group ? sender.id : undefined,
          replyToMessageId,
          clientNonce: deliveryKey,
          markUnread: group ? undefined : options?.forceUnread === true,
        });
        const task = await tx.task.create({
          data: {
            spaceId: run.spaceId,
            botId: target.id,
            threadId: deliveryThreadId,
            userId: run.userId,
            prompt: wakePrompt,
            status: "queued",
          },
        });
        const nextRun = await tx.run.create({
          data: {
            spaceId: run.spaceId,
            botId: target.id,
            threadId: deliveryThreadId,
            taskId: task.id,
            userId: run.userId,
            status: "queued",
            trigger: "bot_message",
            sourceMessageId: inbound.id,
          },
          select: { id: true },
        });
        if (!group) {
          await tx.message.update({ where: { id: inbound.id }, data: { runId: nextRun.id } });
        }
        const inboundEvent = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: deliveryThreadId,
          botId: group ? sender.id : target.id,
          type: "thread.message.created",
          runId: group ? undefined : nextRun.id,
          payload: { messageId: inbound.id, role: inbound.role, blocks: [inboundBlock] },
        });
        if (group) await touchGroupUpdatedAt(tx, group.id);
        const outboundEvent = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          type: "thread.message.created",
          runId: run.id,
          allowCancelledRun: options?.allowTerminalSource === true,
          payload: { messageId: outbound.id, role: "bot", blocks: [outboundBlock] },
        });
        return {
          ok: true as const,
          runId: nextRun.id,
          targetEventSeq: inboundEvent.seq,
          senderEventSeq: outboundEvent.seq,
        };
      }),
    );
  } catch (error) {
    // Two concurrent retries can both miss the in-transaction lookup; the
    // loser hits the unique key. Treat that as a successful replay.
    if (deliveryKey && isUniqueConstraintError(error)) {
      if (await findDelivery(deps.prisma, deliveryRecords)) return replayed();
    }
    throw error;
  }
  if ("replayed" in committed) return replayed();
  if (!committed.ok) return committed;

  await deps.events.notify(deliveryThreadId, committed.targetEventSeq).catch((error) => {
    getLogger().error("bot message realtime notification", error);
  });
  await deps.events.notify(run.threadId, committed.senderEventSeq).catch((error) => {
    getLogger().error("bot message sender echo notification", error);
  });
  await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
    // The queued run is durable; the job reconciler repairs a missed wake.
    getLogger().error("bot message enqueue", error);
  });
  return {
    ok: true as const,
    botId: target.id,
    name: target.name,
    delivered: message,
    note: group
      ? `Posted to ${target.name} in the group chat "${group.name}", where the user can see it. Delivery is async; the reply comes back here and wakes you later as a new message. Continue independent work; send another update later only if it adds something new.`
      : `Sent to ${target.name}. Delivery is async; a reply wakes you later as a new message. Continue independent work; send another update later only if it adds something new.`,
  };
}

async function findDelivery(
  prisma: Pick<PrismaClient, "message">,
  records: readonly { threadId: string; clientNonce: string }[],
) {
  for (const { threadId, clientNonce } of records) {
    const found = await prisma.message.findUnique({
      where: { threadId_clientNonce: { threadId, clientNonce } },
      select: { id: true },
    });
    if (found) return found;
  }
  return undefined;
}

function sharedGroupsWhere(
  run: { spaceId: string; userId: string },
  senderId: string,
  targetId: string,
) {
  return {
    spaceId: run.spaceId,
    userId: run.userId,
    archivedAt: null,
    thread: { isNot: null },
    AND: [senderId, targetId].map((botId) => ({
      members: { some: { botId, bot: { archivedAt: null } } },
    })),
  };
}

/** The one active group both bots belong to; none when they share zero or several. */
async function sharedGroup(
  prisma: PrismaClient,
  run: { spaceId: string; userId: string },
  senderId: string,
  targetId: string,
) {
  const groups = await prisma.chatGroup.findMany({
    where: sharedGroupsWhere(run, senderId, targetId),
    select: { id: true, name: true, thread: { select: { id: true } } },
    take: 2,
  });
  const [group] = groups;
  return groups.length === 1 && group?.thread
    ? { id: group.id, name: group.name, threadId: group.thread.id }
    : undefined;
}

async function sharesGroup(
  tx: Pick<PrismaClient, "chatGroup">,
  run: { spaceId: string; userId: string },
  groupId: string,
  senderId: string,
  targetId: string,
) {
  const groups = await tx.chatGroup.findMany({
    where: sharedGroupsWhere(run, senderId, targetId),
    select: { id: true },
    take: 2,
  });
  return groups.length === 1 && groups[0]?.id === groupId;
}

/** Return a delegated run's terminal outcome unless it already sent one explicitly. */
export async function returnBotMessageOutcome(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
  },
  sender: { id: string; name: string },
  text: string,
  intent: "result" | "status" = "result",
  options?: { forceUnread?: boolean },
) {
  const source = await loadBotMessageContext(deps.prisma, run.sourceMessageId);
  if (!source) {
    await markBotOutcomeReturned(deps.prisma, run.id);
    // Handled: nothing to deliver. Return true so callers do not release a reservation.
    return true;
  }
  const sourceIntent = source.intent ?? "request";
  if (sourceIntent !== "request" && sourceIntent !== "question") {
    await markBotOutcomeReturned(deps.prisma, run.id);
    return true;
  }
  const sent = await deps.prisma.message.findMany({
    where: { threadId: run.threadId, runId: run.id },
    select: { blocks: true },
  });
  // Only an explicit result counts as a terminal outcome. Interim message_bot
  // status updates must not suppress the automatic final return.
  const alreadyReturned = sent.some((message) =>
    (Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : []).some(
      (block) =>
        block.kind === "bot_message_sent" &&
        block.toBotId === source.fromBotId &&
        block.intent === "result",
    ),
  );
  if (alreadyReturned) {
    await markBotOutcomeReturned(deps.prisma, run.id);
    return true;
  }
  const outcome = await messageBot(
    deps,
    run,
    sender,
    {
      bot_id: source.fromBotId,
      message: clampBotMessage(text),
      intent,
      // One key per run so status vs result (executor vs reconciler) cannot double-deliver.
      deliveryKey: `auto-outcome:${run.id}`,
    },
    {
      allowTerminalSource: true,
      forceUnread: options?.forceUnread,
    },
  );
  if (outcome.ok) await markBotOutcomeReturned(deps.prisma, run.id);
  return outcome.ok;
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

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}
