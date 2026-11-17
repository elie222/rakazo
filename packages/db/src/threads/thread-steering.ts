import type { MessageBlock } from "@rakazo/contracts";
import {
  BACKGROUND_HELPER_TRIGGER,
  BACKGROUND_RUN_TRIGGERS,
  blocksToAgentHistoryText,
  HELPER_RESULT_TRIGGER,
  isConversationalRun,
  messagingChannelId,
  QUEUE_HOLDING_RUN_STATUSES,
  STEERING_CONTINUATION_PROMPT,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "../database/client.js";
import {
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withTransactionRetry,
} from "../database/transaction-retry.js";
import { appendEventInTransaction } from "./events.js";
import { mayBeChannelMessage, readMessageBlocks, storedMessageBlocks } from "./message-blocks.js";
import { createThreadMessageInTransaction } from "./messages.js";

export interface ClaimSteeringInput {
  threadId: string;
  botId: string;
  runId: string;
  leaseOwner: string;
  leaseFence: number;
  seenIds: string[];
}

export interface ClaimedSteeringMessage {
  id: string;
  messageId: string;
  text: string;
  blocks: MessageBlock[];
  /**
   * Who sent it: the run's own person (in the app or a connected chat), another member of the
   * chat, someone else in a connected chat, a webhook, or a scheduled task handed over mid-run.
   */
  origin: "user" | "member" | "messaging" | "webhook" | "routine";
}

export async function claimSteering(
  prisma: PrismaClient,
  input: ClaimSteeringInput,
): Promise<ClaimedSteeringMessage[]> {
  // Runs claim before every model turn, so a briefly saturated pool must not fail the run.
  return withTransactionRetry(() => claimSteeringOnce(prisma, input));
}

async function claimSteeringOnce(
  prisma: PrismaClient,
  input: ClaimSteeringInput,
): Promise<ClaimedSteeringMessage[]> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const run = await tx.run.findFirst({
      where: {
        id: input.runId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      select: {
        id: true,
        spaceId: true,
        userId: true,
        trigger: true,
        delegatedFromRunId: true,
        sourceMessage: { select: { id: true, blocks: true } },
      },
    });
    if (!run || run.trigger === "created") return [];
    const delegatedResult = run.trigger === HELPER_RESULT_TRIGGER;
    // Result turns answer in the originating conversation. Their own source is the helper's
    // card, which says nothing about whether pending steering came from a private app chat.
    let conversation: { trigger: string; sourceMessage: { id: string; blocks: unknown } | null } =
      run;
    if (delegatedResult) {
      let originId = run.delegatedFromRunId;
      let found = false;
      for (let depth = 0; originId && depth < 2; depth++) {
        const origin = await tx.run.findFirst({
          where: { id: originId, botId: input.botId, spaceId: run.spaceId, userId: run.userId },
          select: {
            trigger: true,
            threadId: true,
            delegatedFromRunId: true,
            sourceMessage: { select: { id: true, blocks: true } },
          },
        });
        if (!origin) return [];
        if (
          origin.trigger !== BACKGROUND_HELPER_TRIGGER &&
          origin.trigger !== HELPER_RESULT_TRIGGER
        ) {
          if (origin.threadId !== input.threadId) return [];
          conversation = origin;
          found = true;
          break;
        }
        originId = origin.delegatedFromRunId;
      }
      if (!found) return [];
    }
    const messaging = conversation.trigger === "messaging";
    if (delegatedResult && messaging && !conversation.sourceMessage) return [];
    const source =
      messaging && conversation.sourceMessage
        ? readMessageBlocks(conversation.sourceMessage)
        : undefined;
    if (delegatedResult && source?.intact === false) return [];
    const channelId = messagingChannelId(source?.blocks);
    // A source that lost entries may have lost its channel marker, so this run could be a group
    // one: it takes only steering already addressed to it, never the owner's pending private rows.
    const unknownChat = source?.intact === false && !channelId;
    const directMessage = messaging && !channelId && !unknownChat;
    // Pending rows from another chat stay for their own continuation.
    const pendingWhere = directMessage
      ? { runId: null, originTrigger: "messaging" }
      : channelId
        ? { runId: null, originTrigger: "messaging" }
        : { runId: null, originTrigger: null };
    const steering = await tx.steeringMessage.findMany({
      where: {
        botId: input.botId,
        // Only the run's own person's messages; anyone else's wait for a run of their own.
        userId: run.userId,
        ...(delegatedResult ? { originTrigger: messaging ? "messaging" : null } : {}),
        id: input.seenIds.length ? { notIn: input.seenIds } : undefined,
        // A routine or webhook turn only takes steering addressed to it; pending user messages
        // wait for the conversational continuation that starts once it finishes.
        OR:
          isConversationalRun(run.trigger) && !unknownChat
            ? [pendingWhere, { runId: input.runId }]
            : [{ runId: input.runId }],
        message: {
          threadId: input.threadId,
          // Private follow-ups remain unclaimed for the existing private continuation.
          ...(channelId
            ? { blocks: { array_contains: [{ kind: "channel_message", channelId }] } }
            : directMessage
              ? { NOT: { blocks: { array_contains: [{ kind: "channel_message" }] } } }
              : {}),
        },
      },
      include: { message: { select: { id: true, blocks: true, seq: true } } },
      orderBy: [{ message: { seq: "asc" } }, { id: "asc" }],
    });
    if (steering.length === 0) return [];
    await tx.steeringMessage.updateMany({
      where: { id: { in: steering.map((item) => item.id) }, claimedAt: null },
      data: { runId: input.runId, claimedAt: new Date() },
    });
    // The thread lock serializes this watermark with message writes. Unlike claim
    // timestamps, it cannot drift from the database clock or tie with a reply.
    const { nextMessageSeq } = await tx.thread.findUniqueOrThrow({
      where: { id: input.threadId },
      select: { nextMessageSeq: true },
    });
    await appendEventInTransaction(tx, {
      threadId: input.threadId,
      spaceId: run.spaceId,
      botId: input.botId,
      runId: input.runId,
      type: "run.steering.claimed",
      payload: {
        steeringIds: steering.map((item) => item.id),
        nextMessageSeq,
        ...(delegatedResult
          ? {
              externalSafe:
                messaging &&
                steering.every(
                  (item) =>
                    item.originTrigger === "messaging" && readMessageBlocks(item.message).intact,
                ),
            }
          : {}),
      },
    });
    // In a group chat the row's user is the bot's owner, not the sender, so the sender is
    // matched by the address it wrote from.
    const groupSenders = steering.flatMap((item) =>
      storedMessageBlocks(item.message).filter((block) => block.kind === "channel_message"),
    );
    const ownAddresses = new Set(
      groupSenders.length === 0
        ? []
        : (
            await tx.messagingIdentity.findMany({
              where: {
                userId: run.userId,
                OR: groupSenders.map((block) => ({
                  provider: block.provider,
                  address: block.fromAddress,
                })),
              },
              select: { provider: true, address: true },
            })
          ).map((identity) => `${identity.provider}:${identity.address}`),
    );
    const sentByRunPerson = (item: (typeof steering)[number]) => {
      const { blocks, intact } = readMessageBlocks(item.message);
      const group = blocks.find((block) => block.kind === "channel_message");
      if (group) return ownAddresses.has(`${group.provider}:${group.fromAddress}`);
      // A row that lost entries may have lost its group sender: it is not taken as the owner's.
      return intact && item.userId === run.userId;
    };
    return steering.map((item) => {
      const blocks = storedMessageBlocks(item.message);
      return {
        id: item.id,
        messageId: item.messageId,
        text: blocksToAgentHistoryText(blocks),
        blocks,
        origin:
          item.originTrigger === "webhook"
            ? ("webhook" as const)
            : item.originTrigger === "routine"
              ? ("routine" as const)
              : sentByRunPerson(item)
                ? ("user" as const)
                : item.originTrigger === "messaging"
                  ? ("messaging" as const)
                  : ("member" as const),
      };
    });
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
}

export async function discardAnsweredSteering(
  tx: Prisma.TransactionClient,
  input: { threadId: string; runId: string },
) {
  const lastReply = await tx.message.findFirst({
    where: {
      threadId: input.threadId,
      runId: input.runId,
      role: "bot",
      blocks: { array_contains: [{ kind: "text" }] },
      NOT: ["ask", "computer", "steps", "subagent"].map((kind) => ({
        blocks: { array_contains: [{ kind }] },
      })),
    },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  if (!lastReply) return;
  const claims = await tx.event.findMany({
    where: { threadId: input.threadId, runId: input.runId, type: "run.steering.claimed" },
    select: { payload: true },
  });
  const answeredIds = new Set<string>();
  for (const claim of claims) {
    const payload = claim.payload as { steeringIds?: unknown; nextMessageSeq?: unknown } | null;
    if (!payload || !Array.isArray(payload.steeringIds)) continue;
    for (const id of payload.steeringIds) {
      if (typeof id !== "string") continue;
      if (typeof payload.nextMessageSeq === "number" && payload.nextMessageSeq <= lastReply.seq) {
        answeredIds.add(id);
      }
    }
  }
  // Old runs without a durable claim watermark are deliberately replayed.
  if (answeredIds.size === 0) return;
  await tx.steeringMessage.deleteMany({
    where: { runId: input.runId, claimedAt: { not: null }, id: { in: [...answeredIds] } },
  });
}

/**
 * Queue one follow-up when this bot still has unclaimed steering and no live run. A Space being
 * deleted gets it too: its messages were accepted, and the executor holds the run until the
 * deletion ends or is called off.
 */
export async function createPendingSteeringRun(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; threadId: string; botId: string },
): Promise<string | null> {
  const active = await tx.run.findFirst({
    where: {
      threadId: input.threadId,
      botId: input.botId,
      status: { in: [...QUEUE_HOLDING_RUN_STATUSES] },
    },
    select: { id: true },
  });
  if (active) return null;
  const pending = await tx.steeringMessage.findMany({
    where: {
      botId: input.botId,
      runId: null,
      message: { threadId: input.threadId },
    },
    include: { message: { select: { id: true, blocks: true, seq: true } } },
    orderBy: [{ message: { seq: "asc" } }, { id: "asc" }],
  });
  if (pending.length === 0) return null;
  // One origin per continuation so a group channel and the owner's private chat are not answered
  // together. The app and the owner's direct line are one private conversation, answered first.
  // One sender too: the run acts with that person's accounts, and the rest get their own
  // continuation next.
  const origin = pending.some((item) => steeringOrigin(item) === "private")
    ? "private"
    : steeringOrigin(pending[0]!);
  const userId = pending.find((item) => steeringOrigin(item) === origin)!.userId;
  const batch = pending.filter((item) => steeringOrigin(item) === origin && item.userId === userId);
  const source = batch.at(-1)!;
  const modelPin = continuationModelPin(batch);
  const task = await tx.task.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      userId,
      prompt:
        origin === "webhook" || origin === "routine"
          ? blocksToAgentHistoryText(storedMessageBlocks(source.message))
          : STEERING_CONTINUATION_PROMPT,
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      taskId: task.id,
      userId,
      status: "queued",
      // A private continuation is a follow-up the owner wrote only when every message in it came
      // from the app; one direct-line delivery keeps it messaging, so it is never owner-started.
      // Rows queued before origins were recorded are recognized by their channel message.
      trigger:
        origin === "webhook" || origin === "routine"
          ? origin
          : origin === "private" &&
              batch.every(
                (item) => item.originTrigger === null && !mayBeChannelMessage(item.message),
              )
            ? "follow_up"
            : "messaging",
      sourceMessageId: source.message.id,
      ...(modelPin ?? {}),
    },
  });
  await tx.steeringMessage.updateMany({
    where: { id: { in: batch.map((item) => item.id) }, runId: null },
    data: { runId: run.id, claimedAt: null },
  });
  return run.id;
}

function continuationModelPin(
  batch: ReadonlyArray<{
    modelProvider?: string | null;
    modelId?: string | null;
    thinkingLevel?: string | null;
  }>,
) {
  const first = batch[0];
  if (!first?.modelProvider || !first.modelId) return null;
  const agreed = batch.every(
    (item) =>
      item.modelProvider === first.modelProvider &&
      item.modelId === first.modelId &&
      (item.thinkingLevel ?? null) === (first.thinkingLevel ?? null),
  );
  if (!agreed) return null;
  return {
    modelProvider: first.modelProvider,
    modelId: first.modelId,
    thinkingLevel: first.thinkingLevel ?? null,
    modelPinned: true,
  };
}

export function hasChannelMessage(blocks: readonly MessageBlock[]): boolean {
  return blocks.some((block) => block.kind === "channel_message");
}

function steeringOrigin(item: {
  originTrigger: string | null;
  message: { id: string; blocks: unknown };
}): string {
  if (item.originTrigger === "webhook" || item.originTrigger === "routine")
    return item.originTrigger;
  if (item.originTrigger !== "messaging") return "private";
  const { blocks, intact } = readMessageBlocks(item.message);
  const channelId = messagingChannelId(blocks);
  if (channelId) return `channel:${channelId}`;
  // Answered apart from the private conversation, by a run that starts as a group one.
  return intact ? "private" : "channel:unknown";
}

/**
 * A run stopping before its next step, other than by finishing its turn, gives back a handed-over
 * scheduled task it never read, so the task runs on its own instead of waiting on this run.
 */
export async function releaseUnreadHandovers(tx: Prisma.TransactionClient, runId: string) {
  await tx.steeringMessage.updateMany({
    where: { runId, claimedAt: null, originTrigger: "routine" },
    data: { runId: null },
  });
}

/** Chat turns that cannot take a handed-over task: helper results and work kept out of the chat. */
const NO_HANDOVER_TRIGGERS = new Set<string>([HELPER_RESULT_TRIGGER, ...BACKGROUND_RUN_TRIGGERS]);

/**
 * Hands a queued run that never started to the run already working in its conversation: its
 * prompt becomes a hidden message that run reads before its next step, and the queued run ends
 * there. Only a run of the same person takes it, since a run acts with its own person's accounts.
 * Returns null when no run can take it or the queued run started meanwhile.
 */
export async function handQueuedRunToWorkingRun(
  prisma: PrismaClient,
  input: { runId: string; text: string },
): Promise<{ spaceId: string; threadId: string; seq: number; workingRunId: string } | null> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const queued = await tx.run.findUnique({
        where: { id: input.runId },
        select: {
          id: true,
          spaceId: true,
          botId: true,
          threadId: true,
          taskId: true,
          userId: true,
          routine: { select: { watch: true } },
        },
      });
      // Only a saved schedule's own instructions: a watch's note quotes what it read, and other
      // routine-trigger turns, such as check-ins, run with tools of their own.
      if (!queued?.routine || queued.routine.watch !== null) return null;
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${queued.threadId} FOR UPDATE`;
      const candidates = await tx.run.findMany({
        where: {
          id: { not: queued.id },
          threadId: queued.threadId,
          botId: queued.botId,
          userId: queued.userId,
          startedAt: { not: null },
          // Only mid-turn: a run paused for a takeover reads nothing until resumed, and one
          // between attempts would take the task as its opening steering, unlabelled.
          status: "running",
        },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          trigger: true,
          sourceMessage: { select: { id: true, blocks: true } },
        },
      });
      // A group chat's run reads only that channel's messages; a source that lost entries may
      // have lost its channel marker, so it is taken as one.
      const working = candidates.find(({ trigger, sourceMessage }) => {
        if (!isConversationalRun(trigger) || NO_HANDOVER_TRIGGERS.has(trigger)) return false;
        if (!sourceMessage) return true;
        const source = readMessageBlocks(sourceMessage);
        return source.intact && !hasChannelMessage(source.blocks);
      });
      if (!working) return null;
      const now = new Date();
      const ended = await tx.run.updateMany({
        where: { id: queued.id, status: "queued", startedAt: null, leaseOwner: null },
        data: { status: "completed", startedAt: now, completedAt: now, wakeAt: null },
      });
      if (ended.count !== 1) return null;
      await tx.task.update({ where: { id: queued.taskId }, data: { status: "completed" } });
      const blocks: MessageBlock[] = [{ kind: "delivery" }, { kind: "text", text: input.text }];
      const message = await createThreadMessageInTransaction(tx, {
        threadId: queued.threadId,
        role: "user",
        blocks,
        runId: working.id,
      });
      await tx.run.update({ where: { id: queued.id }, data: { sourceMessageId: message.id } });
      await tx.steeringMessage.create({
        data: {
          messageId: message.id,
          botId: queued.botId,
          userId: queued.userId,
          runId: working.id,
          // Its task may quote what a watch read, so it is never taken as the person's own words.
          originTrigger: "routine",
        },
      });
      const event = { spaceId: queued.spaceId, threadId: queued.threadId, botId: queued.botId };
      await appendEventInTransaction(tx, {
        ...event,
        type: "thread.message.created",
        runId: working.id,
        payload: { messageId: message.id, role: "user", blocks },
      });
      const completed = await appendEventInTransaction(tx, {
        ...event,
        type: "run.completed",
        runId: queued.id,
        payload: {},
      });
      return {
        spaceId: queued.spaceId,
        threadId: queued.threadId,
        seq: completed.seq,
        workingRunId: working.id,
      };
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
}
