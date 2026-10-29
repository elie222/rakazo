import type { ProductAnalytics, RealtimeFanout } from "@rakazo/adapter-kit";
import type {
  BotSecretDestination,
  LoginFieldInput,
  MessageBlock,
  ProductEvent,
} from "@rakazo/contracts";
import {
  AnalyticsTrigger,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_SECRET_VALUE_MAX_LENGTH,
  encodeLoginSecret,
  hasThinkingActivityMarker,
  loginAnswerValue,
  MessageBlock as MessageBlockSchema,
  ThreadActivityPayloadSchema,
} from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  blocksToAgentHistoryText,
  callIdFromClientNonce,
  instructionUpdateDiff,
  isApprovalAskBlock,
  isConversationalRun,
  isSecretAskBlock,
  messageBypassesTakeoverWait,
  messageReaction,
  messagingChannelId,
  normalizeRunError,
  QUEUE_HOLDING_RUN_STATUSES,
  releasedTakeoverComputerBlocks,
  resolveAskChoice,
  STEERING_CONTINUATION_PROMPT,
  sanitizeJsonValue,
} from "@rakazo/core";
import { urlSite } from "@rakazo/core/egress";
import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";
import { getLogger } from "@rakazo/logging";
import { saveApprovalRule, storedBatchActions } from "./approval-settings.js";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { Prisma, PrismaClient } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import {
  CrossSpaceCommunicationBlockedError,
  crossSpaceCommunicationAllowed,
} from "./cross-space-communication.js";
import type { RunLease } from "./messages.js";
import {
  assertRunCanWriteHistory,
  assertRunIsCancelled,
  createThreadMessageInTransaction,
  partialReplyClientNonce,
  RunHistoryWriteError,
} from "./messages.js";
import { deleteRunSecretsInTransaction } from "./run-secrets.js";
import { isRunResponse, readRunTimingFields } from "./run-timing.js";
import { RUN_TURN_CHECKPOINT_KIND } from "./run-turn-checkpoint.js";
import { recordSecurityEvent } from "./security-events.js";
import { withTransactionRetry } from "./transaction-retry.js";

/** A one-time answer longer than a saved value may be. Nothing is stored or echoed. */
export class AnswerTooLongError extends Error {
  constructor() {
    super("This answer is too long.");
    this.name = "AnswerTooLongError";
  }
}

const EVENT_BATCH_SIZE = 200;
const PUSH_CATCH_UP_MS = 30_000;
const POLL_ONLY_CATCH_UP_MS = 400;

export interface AppendEventInput {
  spaceId: string;
  threadId: string;
  botId: string;
  type: ProductEvent["type"];
  payload: Record<string, unknown>;
  runId?: string;
  /** Terminal echo after the run is already cancelled. Every other event stays rejected. */
  allowCancelledRun?: boolean;
  /** The executing attempt's lease; a superseded attempt cannot write. Never serialized. */
  lease?: RunLease;
}

/** Exact transient lifecycle payloads only: unrelated thread metadata must survive. */
export function transientRunEventsWhere(): Prisma.EventWhereInput {
  return {
    OR: [
      { type: "thread.progress" },
      { type: "thread.meta", payload: { equals: { activity: { thinking: true } } } },
      { type: "thread.meta", payload: { equals: { activity: { thinking: false } } } },
    ],
  };
}

export interface ThreadEvents {
  answerRunInput(input: AnswerRunInput): Promise<boolean>;
  append(input: AppendEventInput): Promise<ProductEvent>;
  claimSteering(input: ClaimSteeringInput): Promise<ClaimedSteeringMessage[]>;
  clearThread(input: ClearThreadInput): Promise<ClearThreadResult>;
  finalizeComputerControlRelease(
    input: FinalizeComputerControlReleaseInput,
  ): Promise<FinalizeComputerControlReleaseResult | false>;
  finalizeRun(input: FinalizeRunInput): Promise<FinalizeRunResult | false>;
  notify(threadId: string, seq: number, firstResponseRunId?: string): Promise<void>;
  pauseRunForInput(input: PauseRunForInput): Promise<FinalizeRunResult | false>;
  pauseRunForTakeover(input: PauseRunForTakeover): Promise<boolean | { continuationRunId: string }>;
  sendUserMessage(input: SendUserMessageInput): Promise<SendUserMessageResult>;
  follow(threadId: string, cursor: number, signal?: AbortSignal): AsyncGenerator<ProductEvent>;
}

export interface ClearThreadInput {
  spaceId: string;
  threadId: string;
  /** Event author and the bot-scoped target for one-to-one chats. */
  botId: string;
  groupId?: string;
}

export interface ClearThreadResult {
  event: ProductEvent;
  cancelledRunIds: string[];
  historyCompactionGeneration: number;
}

export interface FinalizeComputerControlReleaseInput {
  spaceId: string;
  computerId: string;
  botId: string;
  runId: string | null;
  leaseId: string | null;
  holder: "bot" | "none";
  reason: "done" | "expired" | "released" | "skipped";
}

export interface FinalizeComputerControlReleaseResult {
  runId: string | null;
}

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
   * chat, someone else in a connected chat, or a webhook.
   */
  origin: "user" | "member" | "messaging" | "webhook";
}

export interface FinalizeRunResult {
  continuationRunId: string | null;
}

interface FinalizeRunBase {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  taskId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
}

export type FinalizeRunInput = FinalizeRunBase &
  (
    | {
        outcome: "completed";
        blocks: MessageBlock[];
        markUnread?: boolean;
      }
    | {
        outcome: "failed";
        error: string;
        /** Reply text the user saw streaming before the failure, kept as a bot message. */
        partialReply?: MessageBlock[];
      }
  );

export interface PauseRunForInput {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
  blocks: MessageBlock[];
  /**
   * Unredacted choice actions for resume. Persisted only on the run checkpoint
   * (not in message blocks) so clients still see redacted labels.
   */
  offeredActions?: Array<{ id: string; label: string }>;
}

const CHOICE_ASK_CHECKPOINT_KIND = "choice_ask_v1";

function choiceAskCheckpoint(actions: Array<{ id: string; label: string }>): string {
  return JSON.stringify({ kind: CHOICE_ASK_CHECKPOINT_KIND, actions });
}

function resumeChoiceLabel(
  selected: { id: string; label: string },
  checkpoint: string | null | undefined,
): string {
  if (!checkpoint) return selected.label;
  try {
    const parsed = JSON.parse(checkpoint) as {
      kind?: string;
      actions?: Array<{ id?: unknown; label?: unknown }>;
    };
    if (parsed.kind !== CHOICE_ASK_CHECKPOINT_KIND || !Array.isArray(parsed.actions)) {
      return selected.label;
    }
    const offered = parsed.actions.find((action) => action.id === selected.id);
    return typeof offered?.label === "string" && offered.label.length > 0
      ? offered.label
      : selected.label;
  } catch {
    return selected.label;
  }
}

/**
 * A conversational run's request and earlier answers stay in thread history, so its resumed
 * attempt gets just the answer. A background run's prompt never reaches the thread, so it keeps
 * its instructions and every earlier answer; otherwise the resumed attempt forgets them.
 */
function resumePrompt(
  run: { trigger: string; task?: { prompt: string } | null },
  question: string,
  answer: string,
): string {
  if (isConversationalRun(run.trigger)) return answer;
  return [run.task?.prompt.trim(), `${question.trim()}\nAnswer: ${answer}`]
    .filter(Boolean)
    .join("\n\n");
}

export interface PauseRunForTakeover {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
  reason: string;
  /** Computer that should expose the pending takeover to the UI via controlRunId. */
  computerId: string;
}

export interface AnswerRunInput {
  spaceId: string;
  threadId: string;
  runId: string;
  messageId: string;
  answeredByUserId: string;
  answer: string;
  /** Identifies a spoken answer as part of a live voice call. */
  clientNonce?: string;
  /** A login card's answer, one per requested field. */
  fields?: LoginFieldInput[];
  /** A login card's answer from apps that predate `fields`; `answer` carries its password. */
  username?: string;
  /** Only for a login card: false uses the login for this run only instead of saving it. */
  remember?: false;
  /** Turns down a pending secret request; only the run's user can, and nothing is stored. */
  dismiss?: boolean;
}

/** What request_secret returns to the bot once the user dismissed its card. */
const DISMISSED_SECRET_RESULT = { ok: false, dismissed: true } as const;
const DISMISSED_SECRET_PROMPT = "The user dismissed this request.";

export interface SendUserMessageInput {
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  blocks: MessageBlock[];
  prompt: string;
  trigger: "user" | "follow_up" | "webhook" | "messaging";
  clientNonce?: string;
  linkMessageToRun?: boolean;
  /** Internal bot sender: enforce both bots' cross-space policy in the write transaction. */
  crossSpaceSenderBotId?: string;
  /** When false, persist the user message without starting a run (team-chat transcript). */
  createRun?: boolean;
  /** When true, start a new run even if the bot is already busy (team-chat delivery). */
  allowParallelRun?: boolean;
  /** Model every routine in an inbound delivery agreed on. */
  modelPin?: {
    modelProvider: string;
    modelId: string;
    thinkingLevel: string | null;
  };
}

export interface SendUserMessageResult {
  messageId: string;
  seq: number;
  taskId: string | null;
  runId: string | null;
}

export interface RunSecretWriter {
  withPrepared?<T>(
    prisma: PrismaClient,
    input: AnswerRunInput,
    commit: (writer: RunSecretWriter) => Promise<T>,
  ): Promise<T>;
  store(input: {
    botId: string;
    credential?: BotSecretDestination;
    /** False for a login card answered with "Save to Vault" off. */
    remember: boolean;
    runId: string;
    userId: string;
    spaceId: string;
    plaintext: string;
    tx: Prisma.TransactionClient;
  }): Promise<void>;
}

export function createThreadEvents(
  prisma: PrismaClient,
  realtime?: RealtimeFanout,
  options: {
    catchUpMs?: number;
    runSecretWriter?: RunSecretWriter;
    analytics?: ProductAnalytics;
  } = {},
): ThreadEvents {
  return {
    answerRunInput: (input) => answerRunInput(prisma, input, realtime, options.runSecretWriter),
    append: (input) => appendEvent(prisma, input, realtime, options.analytics),
    claimSteering: (input) => claimSteering(prisma, input),
    clearThread: (input) => clearThread(prisma, input, realtime),
    finalizeComputerControlRelease: (input) =>
      finalizeComputerControlRelease(prisma, input, realtime),
    finalizeRun: (input) => finalizeRun(prisma, input, realtime, options.analytics),
    notify: (threadId, seq, firstResponseRunId) =>
      notifyCommittedEvent(prisma, realtime, threadId, seq, firstResponseRunId),
    pauseRunForInput: (input) => pauseRunForInput(prisma, input, realtime),
    pauseRunForTakeover: (input) => pauseRunForTakeover(prisma, input, realtime),
    sendUserMessage: (input) => sendUserMessage(prisma, input, realtime, options.analytics),
    follow: (threadId, cursor, signal) =>
      followThreadEvents(prisma, threadId, cursor, realtime, signal, options.catchUpMs),
  };
}

export async function clearThread(
  prisma: PrismaClient,
  input: ClearThreadInput,
  realtime?: RealtimeFanout,
): Promise<ClearThreadResult> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const thread = await tx.thread.update({
      where: {
        id: input.threadId,
        spaceId: input.spaceId,
        ...(input.groupId ? { groupId: input.groupId } : { botId: input.botId }),
      },
      data: { unread: false },
      select: { nextMessageSeq: true, historyCompactionGeneration: true },
    });
    const activeRuns = await tx.run.findMany({
      where: {
        spaceId: input.spaceId,
        threadId: input.threadId,
        ...(input.groupId ? {} : { botId: input.botId }),
        status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
      },
      select: { id: true, taskId: true, userId: true, spaceId: true },
    });
    const now = new Date();
    const runIds = activeRuns.map((run) => run.id);
    await cancelRunsInTransaction(tx, activeRuns, now);
    // Expire as tombstones so a still-open provider screen claim cannot reset fencing to 1.
    await expireComputerExecutionLeases(tx, { runId: { in: runIds } });
    await tx.computer.updateMany({
      where: { executionRunId: { in: runIds } },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
    await tx.message.deleteMany({ where: { threadId: input.threadId } });
    await tx.event.deleteMany({ where: { threadId: input.threadId } });
    if (thread.nextMessageSeq > 0) {
      // nextMessageSeq is not reset, so mark every deleted message as already compacted.
      // Leaving the cursor behind would let compaction re-summarize deleted history (or, reset
      // to null, immediately re-fire on the fresh conversation).
      await tx.thread.update({
        where: { id: input.threadId },
        data: {
          historyCompactedUpToSeq: thread.nextMessageSeq - 1,
          historyCompactionSummary: null,
          historyCompactionGeneration: { increment: 1 },
        },
      });
    } else {
      await tx.thread.update({
        where: { id: input.threadId },
        data: {
          historyCompactionSummary: null,
          historyCompactionGeneration: { increment: 1 },
        },
      });
    }
    if (input.groupId) {
      await tx.chatGroup.update({ where: { id: input.groupId }, data: { updatedAt: now } });
    } else {
      await tx.bot.update({
        where: { id: input.botId, spaceId: input.spaceId },
        data: { updatedAt: now },
      });
    }
    const event = await appendEventInTransaction(tx, {
      ...input,
      type: "thread.cleared",
      payload: {},
    });
    return {
      event,
      cancelledRunIds: runIds,
      historyCompactionGeneration: thread.historyCompactionGeneration,
    };
  });
  await notifyRealtime(realtime, committed.event.threadId, committed.event.seq);
  return {
    event: mapProductEvent(committed.event),
    cancelledRunIds: committed.cancelledRunIds,
    historyCompactionGeneration: committed.historyCompactionGeneration,
  };
}

export async function sendUserMessage(
  prisma: PrismaClient,
  input: SendUserMessageInput,
  realtime?: RealtimeFanout,
  analytics?: ProductAnalytics,
): Promise<SendUserMessageResult> {
  const replay = async (): Promise<SendUserMessageResult | null> => {
    if (!input.clientNonce) return null;
    const message = await prisma.message.findUnique({
      where: {
        threadId_clientNonce: {
          threadId: input.threadId,
          clientNonce: input.clientNonce,
        },
      },
    });
    if (!message) return null;
    const created = await prisma.run.findFirst({
      where: { sourceMessageId: message.id },
      orderBy: { createdAt: "asc" },
    });
    const run =
      created ??
      (message.runId ? await prisma.run.findUnique({ where: { id: message.runId } }) : null);
    return {
      messageId: message.id,
      seq: message.seq,
      taskId: created?.taskId ?? null,
      runId: run?.id ?? null,
    };
  };
  const existing = await replay();
  if (existing) return existing;

  const commit = () =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Message first: its thread-row lock serializes the whole send against clearThread, so a
      // concurrent clear either sees the committed run and cancels it, or strictly precedes this
      // transaction. Created in separate transactions, the run could land inside the clear's
      // window and later repopulate the cleared conversation, and a clear could strand the
      // message without its event.
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: "user",
        blocks: input.blocks,
        clientNonce: input.clientNonce,
      });
      if (
        input.crossSpaceSenderBotId &&
        !(await crossSpaceCommunicationAllowed(tx, input.crossSpaceSenderBotId, input.botId))
      ) {
        throw new CrossSpaceCommunicationBlockedError();
      }
      const createRun = input.createRun !== false;
      // Include the creation intro. It has no tools, so it must not absorb the message, and a
      // second run would overlap it on a dedicated computer. Pending steering waits for the
      // continuation that starts when the intro finishes.
      const activeRuns =
        createRun && !input.allowParallelRun
          ? await tx.run.findMany({
              where: {
                threadId: input.threadId,
                botId: input.botId,
                status: {
                  in: [...QUEUE_HOLDING_RUN_STATUSES],
                },
              },
              select: { id: true, taskId: true, trigger: true, status: true },
            })
          : [];
      const holdingRuns = activeRuns.filter(
        (run) => !messageBypassesTakeoverWait(run, input.trigger !== "webhook"),
      );
      // Steer a conversational run when there is one; a routine, webhook, or intro turn only holds the queue.
      const busy =
        holdingRuns.find((run) => isConversationalRun(run.trigger)) ?? holdingRuns[0] ?? null;
      let task = null;
      let run = null;
      if (createRun && !busy) {
        task = await tx.task.create({
          data: {
            spaceId: input.spaceId,
            botId: input.botId,
            threadId: input.threadId,
            userId: input.userId,
            prompt: input.prompt,
            status: "queued",
          },
        });
        run = await tx.run.create({
          data: {
            spaceId: input.spaceId,
            botId: input.botId,
            threadId: input.threadId,
            taskId: task.id,
            userId: input.userId,
            status: "queued",
            trigger: input.trigger,
            clientNonce: input.clientNonce ? `send:${message.id}` : undefined,
            sourceMessageId: message.id,
            ...(input.modelPin
              ? {
                  modelProvider: input.modelPin.modelProvider,
                  modelId: input.modelPin.modelId,
                  thinkingLevel: input.modelPin.thinkingLevel,
                  modelPinned: true,
                }
              : {}),
          },
        });
        if (input.linkMessageToRun) {
          await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
        }
      } else if (createRun && busy) {
        const held = input.trigger === "webhook" || !isConversationalRun(busy.trigger);
        await tx.steeringMessage.create({
          data: {
            messageId: message.id,
            botId: input.botId,
            userId: input.userId,
            // External deliveries retain their origin and never become app follow-ups.
            runId: held ? null : busy.id,
            ...(input.trigger === "messaging" || input.trigger === "webhook"
              ? { originTrigger: input.trigger }
              : {}),
            ...(input.modelPin
              ? {
                  modelProvider: input.modelPin.modelProvider,
                  modelId: input.modelPin.modelId,
                  thinkingLevel: input.modelPin.thinkingLevel,
                }
              : {}),
          },
        });
        await tx.message.update({ where: { id: message.id }, data: { runId: busy.id } });
      }
      const event = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.created",
        runId: run?.id ?? busy?.id,
        payload: {
          messageId: message.id,
          role: "user",
          blocks: input.blocks,
          // Carries the call id on the live event so a spoken turn groups into the
          // call card immediately, instead of after a refetch reads the nonce.
          callId: callIdFromClientNonce(message.clientNonce),
        },
      });
      return { message, task, run, busy, event };
    });
  const committed = await commit().catch(async (error) => {
    const winner = await replay();
    if (winner) return { replay: winner } as const;
    throw error;
  });
  if ("replay" in committed) return committed.replay;
  analytics?.capture(
    input.userId,
    { name: "message_sent", trigger: input.trigger },
    { id: committed.message.id, at: committed.message.createdAt },
  );
  await notifyRealtime(realtime, input.threadId, committed.event.seq).catch((error) => {
    // The event is durable; subscribers recover it from their persisted cursor.
    getLogger().error("user message realtime notification", error);
  });
  return {
    messageId: committed.message.id,
    seq: committed.message.seq,
    taskId: committed.task?.id ?? null,
    runId: committed.run?.id ?? committed.busy?.id ?? null,
  };
}

export async function claimSteering(
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
        sourceMessage: { select: { blocks: true } },
      },
    });
    if (!run || run.trigger === "created") return [];
    const channelId =
      run.trigger === "messaging"
        ? messagingChannelId(run.sourceMessage?.blocks as MessageBlock[] | undefined)
        : undefined;
    const directMessage = run.trigger === "messaging" && !channelId;
    // Pending rows from another chat stay for their own continuation.
    const pendingWhere = directMessage
      ? { runId: null, originTrigger: "messaging" }
      : channelId
        ? { runId: null, originTrigger: "messaging" }
        : { runId: null, originTrigger: null };
    const steering = await tx.steeringMessage.findMany({
      where: {
        botId: input.botId,
        id: input.seenIds.length ? { notIn: input.seenIds } : undefined,
        // A routine or webhook turn only takes steering addressed to it; pending user messages
        // wait for the conversational continuation that starts once it finishes.
        OR: isConversationalRun(run.trigger)
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
      include: { message: { select: { blocks: true, seq: true } } },
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
      payload: { steeringIds: steering.map((item) => item.id), nextMessageSeq },
    });
    // In a group chat the row's user is the bot's owner, not the sender, so the sender is
    // matched by the address it wrote from.
    const groupSenders = steering.flatMap((item) =>
      (item.message.blocks as MessageBlock[]).filter((block) => block.kind === "channel_message"),
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
      const group = (item.message.blocks as MessageBlock[]).find(
        (block) => block.kind === "channel_message",
      );
      return group
        ? ownAddresses.has(`${group.provider}:${group.fromAddress}`)
        : item.userId === run.userId;
    };
    return steering.map((item) => ({
      id: item.id,
      messageId: item.messageId,
      text: blocksToAgentHistoryText(item.message.blocks as MessageBlock[]),
      blocks: item.message.blocks as MessageBlock[],
      origin:
        item.originTrigger === "webhook"
          ? ("webhook" as const)
          : sentByRunPerson(item)
            ? ("user" as const)
            : item.originTrigger === "messaging"
              ? ("messaging" as const)
              : ("member" as const),
    }));
  });
}

async function findPendingAsk(
  tx: Prisma.TransactionClient,
  input: { threadId: string; runId: string },
) {
  const messages = await tx.message.findMany({
    where: {
      threadId: input.threadId,
      runId: input.runId,
      role: "bot",
    },
    orderBy: { seq: "desc" },
    take: 50,
    select: { id: true, blocks: true },
  });
  for (const message of messages) {
    const parsed = MessageBlockSchema.array().safeParse(message.blocks);
    if (!parsed.success) continue;
    const pendingAsk = parsed.data.find(
      (block) => block.kind === "ask" && block.status !== "answered",
    );
    if (pendingAsk?.kind === "ask") return { messageId: message.id, pendingAsk };
  }
  return null;
}

async function commitAnswerRunInput(
  tx: Prisma.TransactionClient,
  input: AnswerRunInput,
  runSecretWriter?: RunSecretWriter,
): Promise<{
  threadId: string;
  seq: number;
  approval?: { decision: string; effectKind: string };
} | null> {
  // Thread row first, then run rows — the same order as clearThread and finalizeRun, so a
  // concurrent clear cannot deadlock against this transaction.
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
  const run = await tx.run.findFirst({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      status: "waiting_input",
    },
    select: {
      botId: true,
      userId: true,
      checkpoint: true,
      trigger: true,
      task: { select: { prompt: true } },
    },
  });
  if (!run) return null;
  const message = await tx.message.findFirst({
    where: {
      id: input.messageId,
      threadId: input.threadId,
      runId: input.runId,
      role: "bot",
    },
  });
  const parsed = MessageBlockSchema.array().safeParse(message?.blocks);
  if (!message || !parsed.success) return null;
  const pendingAsk = parsed.data.find(
    (block) => block.kind === "ask" && block.status !== "answered",
  );
  if (pendingAsk?.kind !== "ask") return null;
  const approvalAsk = isApprovalAskBlock(pendingAsk);
  const secretAsk = isSecretAskBlock(pendingAsk);
  const choiceAsk = !approvalAsk && !secretAsk && Boolean(pendingAsk.actions?.length);
  const selectedChoice = choiceAsk ? resolveAskChoice(input.answer, pendingAsk.actions) : undefined;
  const dismissed = Boolean(input.dismiss);
  // Only the run's user can turn down a secret request; every other card needs an answer.
  if (dismissed && (!secretAsk || run.userId !== input.answeredByUserId || input.answer))
    return null;
  const secretRequest = {
    runId: input.runId,
    spaceId: input.spaceId,
    kind: "request_secret",
    status: "intended",
  };
  if (
    dismissed &&
    !(await tx.externalEffect.findFirst({ where: secretRequest, select: { id: true } }))
  )
    return null;
  if (secretAsk && !dismissed && !runSecretWriter) return null;
  if (secretAsk && pendingAsk.credential && run.userId !== input.answeredByUserId) return null;
  const loginAsk = secretAsk && !dismissed && pendingAsk.credential?.auth.type === "login";
  const login = loginAsk ? loginAnswerValue(pendingAsk.loginFields, input) : undefined;
  // Login fields belong only to a login card, which cannot be saved without them.
  if (loginAsk ? !login : input.username !== undefined || input.fields !== undefined) return null;
  if (input.remember !== undefined && !loginAsk) return null;
  if (secretAsk && input.answer.length > BOT_SECRET_VALUE_MAX_LENGTH)
    throw new AnswerTooLongError();
  let approvalEffect: {
    id: string;
    kind: string;
    request: Prisma.JsonValue;
    batchActions: Prisma.JsonValue;
  } | null = null;
  let editedInstructions: string | undefined;
  let approvalAnswer = input.answer;
  if (approvalAsk && pendingAsk.instructionUpdate && input.answer.startsWith("{")) {
    try {
      const edited = JSON.parse(input.answer);
      if (
        typeof edited.instructions !== "string" ||
        edited.instructions.length > BOT_INSTRUCTIONS_MAX_LENGTH ||
        Object.keys(edited).length !== 1
      )
        return null;
      editedInstructions = edited.instructions;
      approvalAnswer = "allow";
    } catch {
      return null;
    }
  }
  let approvalUserId: string | null = null;

  if (approvalAsk) {
    if (!pendingAsk.actions?.some((action) => action.id === approvalAnswer)) return null;
    approvalEffect = await tx.externalEffect.findFirst({
      where: {
        id: pendingAsk.approvalEffectId,
        spaceId: input.spaceId,
        runId: input.runId,
        status: "intended",
      },
    });
    if (!approvalEffect) return null;
    if (pendingAsk.instructionUpdate) {
      if (
        approvalEffect.kind !== "propose_instructions_update" ||
        pendingAsk.instructionUpdate.botId !== run.botId ||
        (approvalAnswer !== "allow" && approvalAnswer !== "deny") ||
        run.userId !== input.answeredByUserId
      )
        return null;
    }
    if (input.answer === "always") {
      if (run.userId !== input.answeredByUserId) return null;
      approvalUserId = input.answeredByUserId;
    }
  }

  // Answering the creation intro's question tells the bot what it is for, so it resumes as
  // the user's turn: with the conversation and every tool, to get going on that answer.
  const resumedTrigger =
    run.trigger === "created" && !approvalAsk && !secretAsk ? "user" : run.trigger;
  const queued = await tx.run.updateMany({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      status: "waiting_input",
    },
    data: {
      status: "queued",
      ...(resumedTrigger !== run.trigger ? { trigger: resumedTrigger } : {}),
      ...(choiceAsk ? { checkpoint: null } : {}),
    },
  });
  if (queued.count !== 1) return null;

  const recordedAnswer = secretAsk ? "" : (selectedChoice?.id ?? approvalAnswer);
  const callId = callIdFromClientNonce(input.clientNonce);
  const recordsCallUtterance = Boolean(callId && !secretAsk);

  // Give spoken answers the same durable, call-scoped user utterance as other voice turns.
  // Secret asks stay out of message history; the call UI requires those answers on screen.
  if (recordsCallUtterance) {
    const blocks = [{ kind: "text" as const, text: input.answer }];
    const utterance = await createThreadMessageInTransaction(tx, {
      threadId: input.threadId,
      role: "user",
      blocks,
      botId: run.botId,
      runId: input.runId,
      clientNonce: input.clientNonce,
    });
    await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: run.botId,
      type: "thread.message.created",
      runId: input.runId,
      payload: { messageId: utterance.id, role: "user", blocks, callId },
    });
  }

  if (approvalAsk) {
    if (pendingAsk.instructionUpdate) {
      if (editedInstructions !== undefined) {
        const stored = await tx.externalEffect.findUniqueOrThrow({
          where: { id: approvalEffect!.id },
        });
        const request = stored.request as Record<string, Prisma.InputJsonValue>;
        await tx.externalEffect.update({
          where: { id: approvalEffect!.id },
          data: {
            request: { ...request, instructions: editedInstructions },
            idempotencyKey: approvalEffectKey(input.runId, approvalEffect!.kind, {
              ...request,
              instructions: editedInstructions,
            }),
          },
        });
      }
      if (approvalAnswer === "deny")
        await tx.bot.updateMany({
          where: { id: run.botId, pendingInstructionsRunId: input.runId },
          data: { pendingInstructionsRunId: null },
        });
    }
    const allowed = approvalAnswer === "allow" || approvalAnswer === "always";
    await tx.externalEffect.update({
      where: { id: approvalEffect!.id },
      data: { status: allowed ? "approved" : "denied" },
    });
    // "Always" on a fetch card allows that site, never every site the tool can reach, and on a
    // batch allows each action in it, never every action the batch tool can run.
    const site = alwaysAllowedSite(approvalEffect!);
    const tools = storedBatchActions(approvalEffect!.batchActions) ?? [approvalEffect!.kind];
    if (input.answer === "always" && (site || approvalEffect!.kind !== "web_fetch")) {
      // Saved where the member's confirmations apply in this Space: the account or its override.
      for (const tool of site ? [site] : tools) {
        await saveApprovalRule(
          tx,
          { userId: approvalUserId!, spaceId: input.spaceId },
          { effect: "always_allow", matchKind: site ? "site" : "tool", matchValue: tool },
        );
      }
    }
  } else if (dismissed) {
    // Nothing is stored. The bot's request_secret call returns the dismissal, and the resumed
    // run is told why.
    await tx.externalEffect.updateMany({
      where: secretRequest,
      data: { status: "completed", result: DISMISSED_SECRET_RESULT },
    });
    const task = await tx.task.updateMany({
      where: { runs: { some: { id: input.runId } } },
      data: { prompt: resumePrompt(run, pendingAsk.text, DISMISSED_SECRET_PROMPT) },
    });
    if (task.count !== 1) throw new Error("Run task was not available to answer");
  } else if (secretAsk) {
    await runSecretWriter!.store({
      botId: run.botId,
      credential: pendingAsk.credential,
      remember: input.remember !== false,
      runId: input.runId,
      userId: run.userId,
      spaceId: input.spaceId,
      plaintext: login ? encodeLoginSecret(login) : input.answer,
      tx,
    });
    await tx.externalEffect.updateMany({
      where: {
        runId: input.runId,
        spaceId: input.spaceId,
        kind: "request_secret",
        status: "intended",
      },
      data: {
        status: "approved",
        ...(pendingAsk.credential ? { result: { credentialSaved: pendingAsk.credential } } : {}),
      },
    });
  } else {
    const resumeLabel = selectedChoice
      ? resumeChoiceLabel(selectedChoice, run.checkpoint)
      : undefined;
    const task = await tx.task.updateMany({
      where: { runs: { some: { id: input.runId } } },
      data: {
        prompt: resumePrompt(
          { ...run, trigger: resumedTrigger },
          pendingAsk.text,
          selectedChoice ? `Selected choice ${selectedChoice.id}: ${resumeLabel}` : input.answer,
        ),
      },
    });
    if (task.count !== 1) throw new Error("Run task was not available to answer");
  }

  const blocks = parsed.data.map((block) =>
    block === pendingAsk
      ? {
          ...block,
          status: "answered" as const,
          answer: recordedAnswer,
          ...(dismissed ? { dismissed: true as const } : {}),
          ...(input.remember === false ? { remembered: false as const } : {}),
          ...(editedInstructions !== undefined && pendingAsk.instructionUpdate
            ? {
                instructionUpdate: { ...pendingAsk.instructionUpdate, after: editedInstructions },
                detail: instructionUpdateDiff(
                  pendingAsk.instructionUpdate.before,
                  editedInstructions,
                  pendingAsk.instructionUpdate.reason,
                ),
              }
            : {}),
        }
      : block,
  );
  await tx.message.update({ where: { id: message.id }, data: { blocks } });
  const updated = await appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: run.botId,
    type: "thread.message.updated",
    runId: input.runId,
    payload: { messageId: message.id, role: "bot", blocks },
  });
  return {
    threadId: updated.threadId,
    seq: updated.seq,
    ...(approvalEffect
      ? { approval: { decision: approvalAnswer, effectKind: approvalEffect.kind } }
      : {}),
  };
}

export async function answerRunInput(
  prisma: PrismaClient,
  input: AnswerRunInput,
  realtime?: RealtimeFanout,
  runSecretWriter?: RunSecretWriter,
): Promise<boolean> {
  const commit = (writer = runSecretWriter) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) =>
      commitAnswerRunInput(tx, input, writer),
    );
  // A dismissal has no secret to prepare.
  const committed =
    runSecretWriter?.withPrepared && !input.dismiss
      ? await runSecretWriter.withPrepared(prisma, input, commit)
      : await commit();

  if (!committed) return false;
  if (committed.approval) {
    await recordSecurityEvent({
      type: "approval.decided",
      userId: input.answeredByUserId,
      spaceId: input.spaceId,
      metadata: {
        decision: committed.approval.decision,
        effectKind: committed.approval.effectKind,
        runId: input.runId,
      },
    });
  }
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return true;
}

/** The caller holds the thread row lock acquired while accepting the new user message. */
export async function retireWaitingQuestionInTransaction(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; threadId: string; botId: string; runId: string; answer: string },
): Promise<boolean> {
  const answer = input.answer.trim();
  if (!answer) return false;
  const where = {
    id: input.runId,
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: input.botId,
    status: "waiting_input",
  };
  const run = await tx.run.findFirst({ where, select: { taskId: true, userId: true } });
  if (!run) return false;
  const messages = await tx.message.findMany({
    where: { threadId: input.threadId, runId: input.runId, role: "bot" },
    select: { id: true, blocks: true },
  });
  const questions = [];
  for (const message of messages) {
    const parsed = MessageBlockSchema.array().safeParse(message.blocks);
    if (!parsed.success) return false;
    const pending = parsed.data.filter(
      (block) => block.kind === "ask" && block.status !== "answered",
    );
    // Never implicitly dismiss credentials or authorize an external effect, even on a mixed card.
    if (
      pending.some(
        (block) => block.kind === "ask" && (block.input === "secret" || block.approvalEffectId),
      )
    )
      return false;
    if (pending.length) {
      questions.push({
        id: message.id,
        blocks: parsed.data.map((block) =>
          pending.includes(block) ? { ...block, status: "answered" as const, answer } : block,
        ),
      });
    }
  }
  if (!questions.length) return false;
  const now = new Date();
  const retired = await tx.run.updateMany({
    where,
    data: {
      status: "cancelled",
      completedAt: now,
      checkpoint: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
  if (retired.count !== 1) return false;
  await tx.externalEffect.deleteMany({
    where: { runId: input.runId, kind: RUN_TURN_CHECKPOINT_KIND, status: RUN_TURN_CHECKPOINT_KIND },
  });
  await deleteRunSecretsInTransaction(tx, [
    { id: input.runId, userId: run.userId, spaceId: input.spaceId },
  ]);
  await tx.attempt.updateMany({
    where: { runId: input.runId, status: "waiting_input" },
    data: { status: "cancelled", finishedAt: now },
  });
  await tx.task.updateMany({
    where: { id: run.taskId, runs: { none: { status: { in: [...ACTIVE_RUN_STATUSES] } } } },
    data: { status: "cancelled" },
  });
  for (const question of questions) {
    await tx.message.update({ where: { id: question.id }, data: { blocks: question.blocks } });
    await appendEventInTransaction(tx, {
      ...input,
      type: "thread.message.updated",
      allowCancelledRun: true,
      payload: { messageId: question.id, role: "bot", blocks: question.blocks },
    });
  }
  await appendEventInTransaction(tx, { ...input, type: "run.cancelled", payload: {} });
  return true;
}

/** Read-only eligibility shared by image admission and composer free-text answers. */
export async function eligibleWaitingTextAnswer(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    threadId: string;
    runId: string;
    answeredByUserId: string;
    answer: string;
    beforeMessageSeq?: number;
    /** Explicit reaction target; composer replies must pass the latest-message check. */
    messageId?: string;
  },
): Promise<string | null> {
  const answer = input.answer.trim();
  if (!answer) return null;
  const found = await findPendingAsk(tx, input);
  if (!found) return null;
  if (isApprovalAskBlock(found.pendingAsk) || isSecretAskBlock(found.pendingAsk)) return null;
  if (input.messageId !== undefined) {
    if (input.messageId !== found.messageId) return null;
  } else {
    // Reactions are projected beneath their target, not new transcript messages.
    let beforeSeq = input.beforeMessageSeq;
    while (true) {
      const latest = await tx.message.findFirst({
        where: {
          threadId: input.threadId,
          ...(beforeSeq === undefined ? {} : { seq: { lt: beforeSeq } }),
        },
        orderBy: { seq: "desc" },
        select: { id: true, seq: true, role: true, blocks: true, replyToMessageId: true },
      });
      if (!latest) return null;
      if (!messageReaction({ ...latest, blocks: latest.blocks as MessageBlock[] })) {
        if (latest.id !== found.messageId) return null;
        break;
      }
      beforeSeq = latest.seq;
    }
  }
  return found.messageId;
}

/** Commit only answers that pass the same read-only composer eligibility check. */
export async function answerWaitingRunWithTextInTransaction(
  tx: Prisma.TransactionClient,
  input: Parameters<typeof eligibleWaitingTextAnswer>[1],
): Promise<{ threadId: string; seq: number } | null> {
  const messageId = await eligibleWaitingTextAnswer(tx, input);
  return messageId
    ? commitAnswerRunInput(tx, { ...input, messageId, answer: input.answer.trim() })
    : null;
}

export async function pauseRunForInput(
  prisma: PrismaClient,
  input: PauseRunForInput,
  realtime?: RealtimeFanout,
): Promise<FinalizeRunResult | false> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Thread row first, then run rows — the same order as clearThread and finalizeRun, so a
    // concurrent clear cannot deadlock against this transaction.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const paused = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: "waiting_input",
        leaseOwner: null,
        leaseExpiresAt: null,
        ...(input.offeredActions?.length
          ? { checkpoint: choiceAskCheckpoint(input.offeredActions) }
          : {}),
      },
    });
    if (paused.count !== 1) return null;
    await expireComputerExecutionLeases(tx, { runId: input.runId });

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: { status: "waiting_input", finishedAt: new Date() },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to pause");

    const message = await createThreadMessageInTransaction(tx, {
      threadId: input.threadId,
      role: "bot",
      blocks: input.blocks,
      botId: input.botId,
      runId: input.runId,
    });
    const response = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "thread.message.created",
      runId: input.runId,
      payload: { messageId: message.id, role: "bot", blocks: input.blocks },
    });
    const run = await tx.run.findUnique({
      where: { id: input.runId },
      select: { userId: true },
    });
    const waitingEvent = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "run.waiting_input",
      runId: input.runId,
      payload: run?.userId ? { userId: run.userId } : {},
    });
    await tx.event.deleteMany({
      where: { runId: input.runId, ...transientRunEventsWhere() },
    });
    const continuationRunId = await createPendingSteeringRun(tx, input);
    return {
      threadId: waitingEvent.threadId,
      seq: waitingEvent.seq,
      continuationRunId,
      firstResponseRunId: response.firstResponse ? input.runId : undefined,
    };
  });

  if (!committed) return false;
  await notifyCommittedEvent(
    prisma,
    realtime,
    committed.threadId,
    committed.seq,
    committed.firstResponseRunId,
  );
  return { continuationRunId: committed.continuationRunId };
}

export async function pauseRunForTakeover(
  prisma: PrismaClient,
  input: PauseRunForTakeover,
  realtime?: RealtimeFanout,
): Promise<boolean | { continuationRunId: string }> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Release and pause both lock computer, then thread, then run.
    await tx.$queryRaw`
      SELECT id FROM computers WHERE id = ${input.computerId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const run = await tx.run.findUnique({
      where: { id: input.runId },
      select: { checkpoint: true },
    });
    const released = run?.checkpoint === "takeover" || run?.checkpoint === "takeover-skipped";
    const paused = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: released ? "queued" : "waiting_takeover",
        leaseOwner: null,
        leaseExpiresAt: null,
        checkpoint: released ? run.checkpoint : null,
      },
    });
    if (paused.count !== 1) return null;

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: { status: released ? "interrupted" : "waiting_takeover", finishedAt: new Date() },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to pause");

    // A release can finish while the runtime is still preparing its pause. Keep its
    // checkpoint and continue instead of recreating a wait with no control lease.
    if (released) {
      const seq = await settleReleasedTakeoverCardsInTransaction(tx, {
        ...input,
        reason: run.checkpoint === "takeover-skipped" ? "skipped" : "done",
      });
      return { threadId: input.threadId, seq, continuationRunId: input.runId };
    }

    const now = new Date();
    const computer = await tx.computer.findFirst({
      where: { id: input.computerId, spaceId: input.spaceId },
      select: {
        controlHolder: true,
        controlBotId: true,
        controlLeaseId: true,
        controlLeaseExpiresAt: true,
      },
    });
    const activeUserLease = Boolean(
      computer?.controlHolder === "user" &&
        computer.controlLeaseId &&
        computer.controlLeaseExpiresAt &&
        computer.controlLeaseExpiresAt.getTime() > now.getTime(),
    );
    // Keep an active same-bot user lease so Skip / I'm done appear immediately.
    // Preserve another bot's active lease — computer/takeover owns revocation. Do not attach
    // this run to that lease: release validates controlBotId and could clear the binding without
    // resuming the waiting run. The requesting bot's takeover flow binds it after revocation.
    // Otherwise clear stale control, but bind controlRunId so takeoverRequested is true.
    const retainControl = Boolean(activeUserLease && computer?.controlBotId === input.botId);
    const preserveForeignLease = Boolean(
      activeUserLease && computer?.controlBotId && computer.controlBotId !== input.botId,
    );
    const marked = await tx.computer.updateMany({
      where: { id: input.computerId, spaceId: input.spaceId },
      data: retainControl
        ? { state: "running", controlRunId: input.runId }
        : preserveForeignLease
          ? { state: "running" }
          : {
              state: "running",
              controlHolder: "none",
              controlLeaseId: null,
              controlLeaseExpiresAt: null,
              controlBotId: null,
              controlRunId: input.runId,
            },
    });
    if (marked.count !== 1) throw new Error("Computer was not available to mark for takeover");

    const waitingEvent = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "computer.takeover.requested",
      runId: input.runId,
      payload: {
        reason: input.reason,
        takeoverRequested: true,
        retainedControl: retainControl,
      },
    });
    await tx.event.deleteMany({
      where: { runId: input.runId, ...transientRunEventsWhere() },
    });
    return { threadId: waitingEvent.threadId, seq: waitingEvent.seq, continuationRunId: null };
  });

  if (!committed) return false;
  if (committed.seq !== null) {
    await notifyRealtime(realtime, committed.threadId, committed.seq);
  }
  return committed.continuationRunId ? { continuationRunId: committed.continuationRunId } : true;
}

export async function finalizeComputerControlRelease(
  prisma: PrismaClient,
  input: FinalizeComputerControlReleaseInput,
  realtime?: RealtimeFanout,
): Promise<FinalizeComputerControlReleaseResult | false> {
  if (!input.leaseId && !input.runId) return false;
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`
      SELECT id FROM computers WHERE id = ${input.computerId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
    // The same lease can acquire a run binding while provider revocation is in flight.
    // Fence by lease identity, then finalize the current binding under the row lock.
    const computer = await tx.computer.findFirst({
      where: { id: input.computerId, spaceId: input.spaceId },
      select: { controlRunId: true },
    });
    const controlRunId = input.leaseId ? (computer?.controlRunId ?? null) : input.runId;
    let waiting = controlRunId
      ? await tx.run.findUnique({
          where: { id: controlRunId },
          select: { threadId: true, status: true },
        })
      : null;
    const runThreadId = waiting?.threadId ?? null;
    if (runThreadId) {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${runThreadId} FOR UPDATE`;
      waiting = await tx.run.findUnique({
        where: { id: controlRunId! },
        select: { threadId: true, status: true },
      });
    }
    const cleared = await tx.computer.updateMany({
      where: input.leaseId
        ? {
            id: input.computerId,
            spaceId: input.spaceId,
            controlBotId: input.botId,
            controlLeaseId: input.leaseId,
            controlRunId,
          }
        : {
            id: input.computerId,
            spaceId: input.spaceId,
            controlHolder: "none",
            controlBotId: null,
            controlLeaseId: null,
            controlRunId,
          },
      data: {
        controlHolder: input.holder,
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
      },
    });
    if (cleared.count !== 1) return null;

    const checkpoint =
      input.reason === "skipped" || input.reason === "expired" ? "takeover-skipped" : "takeover";
    const resumed = controlRunId
      ? await tx.run.updateMany({
          where: {
            id: controlRunId,
            spaceId: input.spaceId,
            botId: input.botId,
            status: "waiting_takeover",
          },
          data: {
            status: "queued",
            checkpoint,
          },
        })
      : { count: 0 };
    // A steered continue may already hold the run as leased/running. Stamp the
    // checkpoint without stealing the lease so the worker can restore tools.
    const stamped =
      controlRunId && resumed.count !== 1
        ? await tx.run.updateMany({
            where: {
              id: controlRunId,
              spaceId: input.spaceId,
              botId: input.botId,
              status: { in: ["leased", "running"] },
            },
            data: { checkpoint },
          })
        : { count: 0 };
    const runId = resumed.count === 1 || stamped.count === 1 ? controlRunId : null;

    const bot = await tx.bot.findFirst({
      where: { id: input.botId, spaceId: input.spaceId },
      select: { thread: { select: { id: true } } },
    });
    if (!bot?.thread) return { threadId: null, seq: null, runId };

    // Group cards live on the run's thread. Stopped runs cannot write history.
    if (controlRunId && runThreadId && waiting?.status !== "cancelled") {
      await settleReleasedTakeoverCardsInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: runThreadId,
        botId: input.botId,
        runId: controlRunId,
        reason: input.reason,
      });
    }

    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: runThreadId ?? bot.thread.id,
      botId: input.botId,
      runId: runId ?? undefined,
      type: "computer.takeover.released",
      payload: {
        holder: input.holder,
        leaseId: input.leaseId,
        reason: input.reason,
      },
    });
    return { threadId: event.threadId, seq: event.seq, runId };
  });

  if (!committed) return false;
  if (committed.threadId && committed.seq !== null) {
    await notifyRealtime(realtime, committed.threadId, committed.seq);
  }
  return { runId: committed.runId };
}

/**
 * Clear a pending takeover computer card when the run resumes.
 * Release already settles the card; this covers a card that is still pending.
 * No message write and no notify when nothing is pending.
 */
export async function settleReleasedTakeoverCards(
  prisma: PrismaClient,
  input: { spaceId: string; threadId: string; botId: string; runId: string; reason: unknown },
  notify?: (threadId: string, seq: number) => Promise<void>,
): Promise<void> {
  const seq = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    return settleReleasedTakeoverCardsInTransaction(tx, input);
  });
  if (seq !== null) await notify?.(input.threadId, seq);
}

async function settleReleasedTakeoverCardsInTransaction(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; threadId: string; botId: string; runId: string; reason: unknown },
): Promise<number | null> {
  const messages = await tx.message.findMany({
    where: { threadId: input.threadId, runId: input.runId, role: "bot" },
    select: { id: true, blocks: true },
  });
  let lastSeq: number | null = null;
  for (const message of messages) {
    const parsed = MessageBlockSchema.array().safeParse(message.blocks);
    if (!parsed.success) continue;
    const blocks = releasedTakeoverComputerBlocks(parsed.data, input.reason);
    if (!blocks) continue;
    await tx.message.update({
      where: { id: message.id },
      data: { blocks: blocks as Prisma.InputJsonValue },
    });
    const updated = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "thread.message.updated",
      runId: input.runId,
      payload: { messageId: message.id, role: "bot", blocks },
    });
    lastSeq = updated.seq;
  }
  return lastSeq;
}

export async function appendEvent(
  prisma: PrismaClient,
  input: AppendEventInput,
  realtime?: RealtimeFanout,
  analytics?: ProductAnalytics,
): Promise<ProductEvent> {
  // Concurrent writers in one thread (group members, bot messages) can deadlock on the thread row.
  const event = await withTransactionRetry(() =>
    prisma.$transaction((tx: Prisma.TransactionClient) => appendEventInTransaction(tx, input)),
  );
  if (
    input.runId &&
    (input.type === "run.started" || input.type === "run.completed" || input.type === "run.failed")
  ) {
    void captureRunAnalytics(prisma, analytics, input.runId, input.type);
  }
  const productEvent = mapProductEvent(event);
  await notifyCommittedEvent(
    prisma,
    realtime,
    event.threadId,
    event.seq,
    event.firstResponse ? input.runId : undefined,
  );
  return productEvent;
}

export async function finalizeRun(
  prisma: PrismaClient,
  input: FinalizeRunInput,
  realtime?: RealtimeFanout,
  analytics?: ProductAnalytics,
): Promise<FinalizeRunResult | false> {
  const committed = await withTransactionRetry(() => finalizeRunOnce(prisma, input));
  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  const timing = await readRunTimingFields(prisma, input.runId);
  if (committed.firstResponse) {
    getLogger().info("run.first_response", { "run.id": input.runId, ...timing });
  }
  getLogger().info("run.finished", {
    "run.id": input.runId,
    "run.outcome": input.outcome,
    ...timing,
    "space.id": input.spaceId,
    "thread.id": input.threadId,
    "bot.id": input.botId,
  });
  void captureRunAnalytics(prisma, analytics, input.runId, `run.${input.outcome}`);
  return { continuationRunId: committed.continuationRunId };
}

/** Stamps one turn-level wall-clock duration on the final tool block. */
export function completedRunBlocks(
  blocks: MessageBlock[],
  startedAt: Date | null,
  completedAt: Date,
): MessageBlock[] {
  if (!startedAt) return blocks;
  const durationMs = completedAt.getTime() - startedAt.getTime();
  if (!Number.isFinite(durationMs) || durationMs < 0) return blocks;
  const index = blocks.findLastIndex((block) => block.kind === "steps");
  if (index < 0) return blocks;
  return blocks.map((block, blockIndex) =>
    blockIndex === index && block.kind === "steps"
      ? { ...block, durationMs: Math.round(durationMs) }
      : block,
  );
}

// The thread lock is shared with snapshot reads that may hold it for up to 15s. Prisma's 5s
// default counts that wait, and expiring would fail a run whose work already finished.
const FINALIZE_TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 20_000 };

async function finalizeRunOnce(
  prisma: PrismaClient,
  input: FinalizeRunInput,
): Promise<{
  threadId: string;
  seq: number;
  continuationRunId: string | null;
  firstResponse: boolean;
} | null> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    let writableRun: { startedAt: Date | null; userId: string } | undefined;
    try {
      writableRun = await assertRunCanWriteHistory(tx, input.runId);
    } catch (error) {
      if (error instanceof RunHistoryWriteError) return null;
      throw error;
    }
    const now = new Date();
    const terminal = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        taskId: input.taskId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: input.outcome,
        error: input.outcome === "failed" ? input.error : null,
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    if (terminal.count !== 1) return null;
    await tx.externalEffect.deleteMany({
      where: {
        runId: input.runId,
        kind: RUN_TURN_CHECKPOINT_KIND,
        status: RUN_TURN_CHECKPOINT_KIND,
      },
    });

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: {
        status: input.outcome,
        error: input.outcome === "failed" ? input.error : null,
        finishedAt: now,
      },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to finalize");

    const task = await tx.task.updateMany({
      where: {
        id: input.taskId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
      },
      data: { status: input.outcome },
    });
    if (task.count !== 1) throw new Error("Run task was not available to finalize");

    if (input.outcome === "failed") {
      // Before the partial reply below is saved: a reply the failure cut short answers no
      // steering, so the steering it was answering still gets a run of its own.
      await discardAnsweredSteering(tx, input);
      const { sourceMessage } = await tx.run.findUniqueOrThrow({
        where: { id: input.runId },
        select: { sourceMessage: { select: { seq: true } } },
      });
      // A continuation's source is the newest steering it was created for. Only newer
      // messages justify another run after failure, even if setup failed before claiming.
      await tx.steeringMessage.updateMany({
        where: {
          runId: input.runId,
          message: sourceMessage ? { seq: { gt: sourceMessage.seq } } : undefined,
        },
        data: { runId: null },
      });
    }
    let firstResponse = false;
    const replyBlocks =
      input.outcome === "completed"
        ? completedRunBlocks(input.blocks, writableRun?.startedAt ?? null, now)
        : (input.partialReply ?? []);
    if (replyBlocks.length > 0) {
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: "bot",
        blocks: replyBlocks,
        botId: input.botId,
        runId: input.runId,
        ...(input.outcome === "completed"
          ? { markUnread: input.markUnread }
          : { clientNonce: partialReplyClientNonce(input.runId) }),
      });
      const response = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.created",
        runId: input.runId,
        payload: { messageId: message.id, role: "bot", blocks: replyBlocks },
      });
      firstResponse = response.firstResponse;
    }
    const lastEvent = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: input.outcome === "completed" ? "run.completed" : "run.failed",
      runId: input.runId,
      payload: input.outcome === "completed" ? {} : { error: input.error },
    });
    await tx.event.deleteMany({
      where: { runId: input.runId, ...transientRunEventsWhere() },
    });
    if (writableRun) {
      await deleteRunSecretsInTransaction(tx, [
        { id: input.runId, userId: writableRun.userId, spaceId: input.spaceId },
      ]);
    }
    if (input.outcome === "completed") {
      await tx.steeringMessage.deleteMany({
        where: { runId: input.runId, claimedAt: { not: null } },
      });
      await tx.steeringMessage.updateMany({
        where: { runId: input.runId },
        data: { runId: null },
      });
    }
    const continuationRunId = await createPendingSteeringRun(tx, input);
    await tx.bot.update({ where: { id: input.botId }, data: { updatedAt: now } });
    return { threadId: lastEvent.threadId, seq: lastEvent.seq, continuationRunId, firstResponse };
  }, FINALIZE_TRANSACTION_OPTIONS);
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

/** Queue one follow-up when this bot still has unclaimed steering and no live run. */
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
  // together. The app and the owner's direct line are one private conversation.
  const origin = steeringOrigin(pending[0]!);
  const batch = pending.filter((item) => steeringOrigin(item) === origin);
  const source = batch.at(-1)!;
  const modelPin = continuationModelPin(batch);
  const task = await tx.task.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      userId: batch[0]!.userId,
      prompt:
        origin === "webhook"
          ? blocksToAgentHistoryText(source.message.blocks as MessageBlock[])
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
      userId: batch[0]!.userId,
      status: "queued",
      // A private continuation is a follow-up the owner wrote only when every message in it came
      // from the app; one direct-line delivery keeps it messaging, so it is never owner-started.
      // Rows queued before origins were recorded are recognized by their channel message.
      trigger:
        origin === "webhook"
          ? "webhook"
          : origin === "private" &&
              batch.every(
                (item) => item.originTrigger === null && !hasChannelMessage(item.message.blocks),
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

function hasChannelMessage(blocks: unknown): boolean {
  return (blocks as MessageBlock[]).some((block) => block.kind === "channel_message");
}

function steeringOrigin(item: {
  originTrigger: string | null;
  message: { blocks: unknown };
}): string {
  if (item.originTrigger === "webhook") return "webhook";
  if (item.originTrigger !== "messaging") return "private";
  const channelId = messagingChannelId(item.message.blocks as MessageBlock[] | undefined);
  return channelId ? `channel:${channelId}` : "private";
}

export async function appendEventInTransaction(
  tx: Prisma.TransactionClient,
  input: AppendEventInput,
) {
  const activity = input.type === "thread.meta" && hasThinkingActivityMarker(input.payload);
  if (activity) {
    ThreadActivityPayloadSchema.parse(input.payload);
    if (!input.runId || !input.lease) throw new RunHistoryWriteError();
  }
  const thread = await tx.thread
    .update({
      where: { id: input.threadId },
      data: { nextEventSeq: { increment: 1 } },
      select: { nextEventSeq: true },
    })
    .catch((error: unknown) => {
      // Deleting the bot or space cascades the thread and its runs away under
      // in-flight work; that run has no history left to write to.
      if (input.runId && isRecordNotFound(error)) throw new RunHistoryWriteError();
      throw error;
    });
  // run.cancelled is appended after the run row already reads cancelled, so it
  // asserts the terminal status where every other event needs a writable run.
  let firstResponseAt: Date | null | undefined;
  if (input.type === "run.cancelled") {
    await assertRunIsCancelled(tx, input.runId);
  } else {
    const run = await assertRunCanWriteHistory(tx, input.runId, {
      allowCancelled: input.allowCancelledRun,
      lease: input.lease,
    });
    if (activity && (run?.status !== "running" || run.leaseOwner !== input.lease?.owner)) {
      throw new RunHistoryWriteError();
    }
    firstResponseAt = run?.firstResponseAt;
  }
  // Unpaired UTF-16 surrogates (e.g. a split emoji high half) are invalid JSON for Postgres.
  const payload = sanitizeJsonValue(input.payload);
  const event = await tx.event.create({
    data: {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      seq: thread.nextEventSeq - 1,
      type: input.type,
      payload: payload as Prisma.InputJsonValue,
      runId: input.runId,
    },
  });
  const firstResponse = Boolean(
    input.runId &&
      !firstResponseAt &&
      isRunResponse(input.type, input.payload) &&
      (
        await tx.run.updateMany({
          where: { id: input.runId, firstResponseAt: null },
          data: { firstResponseAt: event.createdAt },
        })
      ).count === 1,
  );
  return { ...event, firstResponse };
}

function isRecordNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2025");
}

/** Timing metadata is returned by the transaction that recorded first output. */
async function notifyCommittedEvent(
  prisma: PrismaClient,
  realtime: RealtimeFanout | undefined,
  threadId: string,
  seq: number,
  firstResponseRunId?: string,
): Promise<void> {
  await notifyRealtime(realtime, threadId, seq);
  if (!firstResponseRunId) return;
  getLogger().info("run.first_response", {
    "run.id": firstResponseRunId,
    ...(await readRunTimingFields(prisma, firstResponseRunId)),
  });
}

export async function notifyRealtime(
  realtime: RealtimeFanout | undefined,
  threadId: string,
  cursor: number,
): Promise<void> {
  await realtime?.publish(threadTopic(threadId), JSON.stringify({ cursor })).catch(() => undefined);
}

export async function eventsAfter(
  prisma: PrismaClient,
  threadId: string,
  cursor: number,
  limit?: number,
) {
  return prisma.event.findMany({
    where: { threadId, seq: { gt: cursor } },
    orderBy: { seq: "asc" },
    ...(limit ? { take: limit } : {}),
  });
}

export async function* followThreadEvents(
  prisma: PrismaClient,
  threadId: string,
  cursor: number,
  realtime?: RealtimeFanout,
  signal?: AbortSignal,
  catchUpMs = realtime ? PUSH_CATCH_UP_MS : POLL_ONLY_CATCH_UP_MS,
): AsyncGenerator<ProductEvent> {
  let seq = cursor;
  const latch = new ChangeLatch();
  const unsubscribe = realtime
    ? await realtime
        .subscribe(threadTopic(threadId), () => latch.notify())
        .catch(() => async () => {})
    : async () => {};
  try {
    while (!signal?.aborted) {
      const observedGeneration = latch.generation;
      let batchSize = 0;
      do {
        const events = await eventsAfter(prisma, threadId, seq, EVENT_BATCH_SIZE);
        batchSize = events.length;
        for (const event of events) {
          seq = event.seq;
          yield mapProductEvent(event);
        }
      } while (batchSize === EVENT_BATCH_SIZE && !signal?.aborted);
      if (signal?.aborted) break;
      await latch.waitForChange(observedGeneration, catchUpMs, signal);
    }
  } finally {
    await unsubscribe();
  }
}

function threadTopic(threadId: string): string {
  return `thread:${threadId}`;
}

function mapProductEvent(event: {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  seq: number;
  type: string;
  payload: unknown;
  runId: string | null;
  createdAt: Date;
}): ProductEvent {
  return {
    id: event.id,
    spaceId: event.spaceId,
    threadId: event.threadId,
    botId: event.botId,
    seq: event.seq,
    type: event.type as ProductEvent["type"],
    runId: event.runId ?? undefined,
    createdAt: event.createdAt.toISOString(),
    payload: event.payload as Record<string, unknown>,
  };
}

class ChangeLatch {
  generation = 0;
  private wake: (() => void) | undefined;

  notify(): void {
    this.generation += 1;
    this.wake?.();
  }

  async waitForChange(expected: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.generation !== expected || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        if (this.wake === finish) this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.wake = finish;
      signal?.addEventListener("abort", finish, { once: true });
      if (this.generation !== expected || signal?.aborted) finish();
    });
  }
}

async function captureRunAnalytics(
  prisma: PrismaClient,
  analytics: ProductAnalytics | undefined,
  runId: string,
  type: "run.started" | "run.completed" | "run.failed",
): Promise<void> {
  if (!analytics) return;
  try {
    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: {
        userId: true,
        trigger: true,
        error: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
      },
    });
    if (!run) return;
    const trigger = AnalyticsTrigger.safeParse(run.trigger);
    if (!trigger.success) return;
    const identity = {
      id: runId,
      at: (type === "run.started" ? run.startedAt : run.completedAt) ?? run.createdAt,
    };
    if (type === "run.failed")
      analytics.capture(
        run.userId,
        {
          name: "run_failed",
          trigger: trigger.data,
          // Only the coarse kind leaves the database; the error text itself never does.
          errorKind: normalizeRunError(run.error ?? "").kind ?? "other",
        },
        identity,
      );
    else
      analytics.capture(
        run.userId,
        { name: type === "run.started" ? "run_started" : "run_completed", trigger: trigger.data },
        identity,
      );
  } catch {
    // Measurement must never turn a committed run into a failed request or worker job.
    getLogger().warn("Run analytics unavailable.");
  }
}

function alwaysAllowedSite(effect: {
  kind: string;
  request: Prisma.JsonValue;
}): string | undefined {
  if (effect.kind !== "web_fetch") return undefined;
  const request = effect.request as { url?: unknown } | null;
  return typeof request?.url === "string" ? urlSite(request.url) : undefined;
}
