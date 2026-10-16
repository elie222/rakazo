import { runContinueJob } from "@rakazo/adapter-kit";
import type { BotMessageIntent, MessageBlock } from "@rakazo/contracts";
import type { BotMessageContext } from "@rakazo/core";
import {
  BOT_MESSAGE_MAX_LENGTH,
  botMessageContext,
  botMessageHopExhausted,
  buildBotMessageWakePrompt,
  clampBotMessage,
  nextBotMessageHop,
} from "@rakazo/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  type PrismaClient,
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

type MessageBotSpace = { id: string; name: string; organizationId: string };

export type MessageBotTargetBinding = {
  source: {
    spaceId: string;
    spaceName: string;
    threadId: string;
    botId: string;
    userId: string;
  };
  target: {
    spaceId: string;
    spaceName: string;
    botId: string;
    botName: string;
    threadId: string;
  };
  requested: {
    targetSpace: string;
    botId?: string;
    confirmName?: string;
    message: string;
    intent: BotMessageIntent;
  };
  provenance?: { inboundMessageId: string; outboundMessageId: string };
};

export type MessageBotTargetEffectRequest = {
  kind: "rakazo.message_bot.target.v1";
  binding: MessageBotTargetBinding;
  args: {
    target_space: string;
    bot_id: string;
    confirm_name: string;
    message: string;
    intent: BotMessageIntent;
  };
};

export type PreparedMessageBotTarget = {
  ok: true;
  crossSpace: boolean;
  args: Record<string, unknown>;
  target: MessageBotTargetBinding["target"];
  sourceSpaceName: string;
  binding?: MessageBotTargetBinding;
  effectRequest?: MessageBotTargetEffectRequest;
  reviewArgs?: Record<string, unknown>;
};

type MessageBotTargetPreparation = PreparedMessageBotTarget | { ok: false; error: string };

/** Parse the persisted cross-Space approval request without trusting its shape. */
export function parseMessageBotTargetEffectRequest(
  value: unknown,
): MessageBotTargetEffectRequest | undefined {
  if (!isRecord(value) || value.kind !== "rakazo.message_bot.target.v1") return undefined;
  const binding = value.binding;
  if (!isRecord(binding) || !isRecord(binding.source) || !isRecord(binding.target))
    return undefined;
  if (!isRecord(binding.requested) || !isRecord(value.args)) return undefined;
  const source = binding.source;
  const target = binding.target;
  const requested = binding.requested;
  const args = value.args;
  if (
    ![
      source.spaceId,
      source.spaceName,
      source.threadId,
      source.botId,
      source.userId,
      target.spaceId,
      target.spaceName,
      target.botId,
      target.botName,
      target.threadId,
      requested.targetSpace,
      requested.message,
    ].every(isNonEmptyString) ||
    !isBotMessageIntent(requested.intent) ||
    !isNonEmptyString(args.target_space) ||
    !isNonEmptyString(args.bot_id) ||
    !isNonEmptyString(args.confirm_name) ||
    typeof args.message !== "string" ||
    !isBotMessageIntent(args.intent)
  ) {
    return undefined;
  }
  if (
    source.spaceId === target.spaceId ||
    (requested.targetSpace !== target.spaceId && requested.targetSpace !== target.spaceName) ||
    (requested.botId !== undefined &&
      (!isNonEmptyString(requested.botId) || requested.botId !== target.botId)) ||
    (requested.confirmName !== undefined &&
      (!isNonEmptyString(requested.confirmName) || requested.confirmName !== target.botName)) ||
    args.target_space !== target.spaceId ||
    args.bot_id !== target.botId ||
    args.confirm_name !== target.botName ||
    args.message !== requested.message ||
    args.intent !== requested.intent
  ) {
    return undefined;
  }
  return value as MessageBotTargetEffectRequest;
}

/** Bind a model's cross-Space selector to current user-accessible IDs before approval. */
export async function prepareMessageBotTarget(
  prisma: PrismaClient,
  run: Pick<MessageBotTargetBinding["source"], "spaceId" | "threadId" | "botId" | "userId">,
  input: {
    target_space: unknown;
    bot_id?: unknown;
    confirm_name?: unknown;
    message: string;
    intent?: unknown;
  },
): Promise<MessageBotTargetPreparation> {
  if (typeof input.target_space !== "string" || !input.target_space.trim()) {
    return { ok: false, error: "target_space must be a Space name or ID." };
  }
  const resolvedSpace = await resolveMessageBotSpace(prisma, run, input.target_space);
  if ("error" in resolvedSpace) return { ok: false, error: resolvedSpace.error };
  const recipient = await resolveMessageBotRecipient(
    prisma,
    resolvedSpace.target.id,
    run.userId,
    input,
  );
  if ("error" in recipient) return { ok: false as const, error: recipient.error };
  const intent = isBotMessageIntent(input.intent) ? input.intent : "request";
  const message = input.message.trim();
  const args = {
    target_space: resolvedSpace.target.id,
    bot_id: recipient.id,
    confirm_name: recipient.name,
    message,
    intent,
  };
  const target = {
    spaceId: resolvedSpace.target.id,
    spaceName: resolvedSpace.target.name,
    botId: recipient.id,
    botName: recipient.name,
    threadId: recipient.thread!.id,
  };
  if (resolvedSpace.target.id === run.spaceId) {
    return {
      ok: true,
      crossSpace: false,
      args,
      target,
      sourceSpaceName: resolvedSpace.source.name,
    };
  }
  const requestedBotId = optionalString(input.bot_id);
  const requestedConfirmName = optionalString(input.confirm_name);
  const binding: MessageBotTargetBinding = {
    source: {
      spaceId: run.spaceId,
      spaceName: resolvedSpace.source.name,
      threadId: run.threadId,
      botId: run.botId,
      userId: run.userId,
    },
    target,
    requested: {
      targetSpace: input.target_space.trim(),
      ...(requestedBotId ? { botId: requestedBotId } : {}),
      ...(requestedConfirmName ? { confirmName: recipient.name } : {}),
      message,
      intent,
    },
  };
  const effectRequest: MessageBotTargetEffectRequest = {
    kind: "rakazo.message_bot.target.v1",
    binding,
    args,
  };
  return {
    ok: true,
    crossSpace: true,
    args,
    target,
    sourceSpaceName: resolvedSpace.source.name,
    binding,
    effectRequest,
    reviewArgs: {
      source_space: resolvedSpace.source.name,
      source_space_id: resolvedSpace.source.id,
      target_space: resolvedSpace.target.name,
      target_space_id: resolvedSpace.target.id,
      bot_id: recipient.id,
      confirm_name: recipient.name,
      message,
      intent,
    },
  };
}

async function resolveMessageBotSpace(
  prisma: Pick<PrismaClient, "spaceMember">,
  run: Pick<MessageBotTargetBinding["source"], "spaceId" | "userId">,
  requestedSpace: string,
): Promise<{ source: MessageBotSpace; target: MessageBotSpace } | { error: string }> {
  const target = requestedSpace.trim();
  const sourceMembership = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: run.spaceId, userId: run.userId } },
    select: {
      organizationId: true,
      space: { select: { id: true, name: true, deletingAt: true } },
    },
  });
  if (!sourceMembership || sourceMembership.space.deletingAt) {
    return { error: "The current Space is no longer active for this user." };
  }
  const memberships = await prisma.spaceMember.findMany({
    where: {
      userId: run.userId,
      organizationId: sourceMembership.organizationId,
      space: { deletingAt: null },
    },
    select: {
      spaceId: true,
      space: { select: { id: true, name: true, deletingAt: true } },
    },
  });
  const matches = memberships.filter(
    (membership) =>
      !membership.space.deletingAt &&
      (membership.spaceId === target || membership.space.name.trim() === target),
  );
  if (matches.length === 0) {
    return { error: `No active Space you can access in this organization matches “${target}”.` };
  }
  if (matches.length > 1) {
    return { error: `More than one active Space matches “${target}”; use its Space ID.` };
  }
  const match = matches[0]!;
  return {
    source: {
      id: sourceMembership.space.id,
      name: sourceMembership.space.name,
      organizationId: sourceMembership.organizationId,
    },
    target: {
      id: match.spaceId,
      name: match.space.name,
      organizationId: sourceMembership.organizationId,
    },
  };
}

async function resolveMessageBotRecipient(
  prisma: Pick<PrismaClient, "bot">,
  spaceId: string,
  userId: string,
  input: { bot_id?: unknown; confirm_name?: unknown },
) {
  const botId = optionalString(input.bot_id);
  const confirmName = optionalString(input.confirm_name);
  const candidates = await prisma.bot.findMany({
    where: { spaceId, userId, archivedAt: null },
    select: {
      id: true,
      name: true,
      title: true,
      thread: { select: { id: true, spaceId: true, botId: true } },
    },
  });
  let matches = candidates;
  if (botId) matches = candidates.filter((candidate) => candidate.id === botId);
  else if (confirmName) {
    const normalized = confirmName.toLowerCase();
    const exact = candidates.filter((candidate) => candidate.name === confirmName);
    matches = exact.length
      ? exact
      : candidates.filter((candidate) => candidate.name.trim().toLowerCase() === normalized);
  } else {
    return { error: "Provide bot_id or confirm_name for the recipient." };
  }
  if (!matches.length) return { error: "no bot found with that id or name" };
  if (matches.length > 1) return { error: "More than one active bot matches; use its bot ID." };
  const target = matches[0]!;
  if (botId && confirmName && target.name !== confirmName) {
    return { error: "bot_id and confirm_name do not identify the same current bot." };
  }
  if (!target.thread || target.thread.spaceId !== spaceId || target.thread.botId !== target.id) {
    return { error: `${target.name} has no chat in this Space to deliver to.` };
  }
  return target;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isBotMessageIntent(value: unknown): value is BotMessageIntent {
  return (
    value === "request" ||
    value === "result" ||
    value === "question" ||
    value === "status" ||
    value === "fyi"
  );
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
    target_space?: string;
    message: string;
    intent?: BotMessageIntent;
    deliveryKey?: string;
  },
  options?: {
    allowTerminalSource?: boolean;
    forceUnread?: boolean;
    targetBinding?: MessageBotTargetBinding;
  },
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
  const intent = isBotMessageIntent(input.intent) ? input.intent : "request";
  const hop = nextBotMessageHop(sourceContext?.hop);
  let targetBinding = options?.targetBinding;
  let targetSpaceId = run.spaceId;
  let target: { id: string; name: string; title?: string; thread: { id: string } | null };
  if (targetBinding) {
    if (
      targetBinding.source.spaceId !== run.spaceId ||
      targetBinding.source.threadId !== run.threadId ||
      targetBinding.source.botId !== run.botId ||
      targetBinding.source.userId !== run.userId ||
      targetBinding.source.botId !== sender.id ||
      targetBinding.target.botId !== input.bot_id ||
      targetBinding.target.botName !== input.confirm_name ||
      targetBinding.requested.message !== message ||
      targetBinding.requested.intent !== intent
    ) {
      return { ok: false as const, error: "The bound bot message request no longer matches." };
    }
    targetSpaceId = targetBinding.target.spaceId;
    target = {
      id: targetBinding.target.botId,
      name: targetBinding.target.botName,
      thread: { id: targetBinding.target.threadId },
    };
  } else if (input.target_space !== undefined) {
    const prepared = await prepareMessageBotTarget(deps.prisma, run, {
      ...input,
      target_space: input.target_space,
      message,
      intent,
    });
    if (!prepared.ok) return { ok: false as const, error: prepared.error };
    targetSpaceId = prepared.target.spaceId;
    target = {
      id: prepared.target.botId,
      name: prepared.target.botName,
      thread: { id: prepared.target.threadId },
    };
    targetBinding = prepared.binding;
  } else {
    const recipient = await resolveMessageBotRecipient(deps.prisma, run.spaceId, run.userId, input);
    if ("error" in recipient) return { ok: false as const, error: recipient.error };
    target = recipient;
  }
  if (target.id === sender.id) return { ok: false as const, error: "a bot cannot message itself" };
  if (!target.thread)
    return { ok: false as const, error: `${target.name} has no chat to deliver to` };
  const crossSpace = targetSpaceId !== run.spaceId;
  if (crossSpace && !targetBinding) {
    return { ok: false as const, error: "Cross-Space delivery requires a bound destination." };
  }
  const returnsToSender =
    options?.allowTerminalSource === true &&
    (intent === "result" || intent === "status") &&
    (sourceContext?.intent === undefined ||
      sourceContext.intent === "request" ||
      sourceContext.intent === "question") &&
    sourceContext?.fromBotId === target.id &&
    (!crossSpace || Boolean(targetBinding?.provenance));
  if (botMessageHopExhausted(hop) && !returnsToSender) {
    return {
      ok: false as const,
      error:
        "bot-to-bot message limit reached for this chain; report back to the user instead of messaging another bot",
    };
  }

  const targetThreadId = targetBinding?.target.threadId ?? target.thread.id;

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

  const wakePrompt = buildBotMessageWakePrompt({ from: sender, text: message, intent });
  const outboundBlock = {
    kind: "bot_message_sent",
    toBotId: target.id,
    toBotName: target.name,
    text: message,
    intent,
    ...(crossSpace
      ? {
          toSpaceId: targetBinding!.target.spaceId,
          toSpaceName: targetBinding!.target.spaceName,
          toThreadId: targetThreadId,
        }
      : {}),
  } as MessageBlock;

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
        if (crossSpace) {
          for (const spaceId of [run.spaceId, targetSpaceId].sort()) {
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${spaceId}, 0))::text AS "lock"`;
            await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${spaceId} FOR UPDATE`;
            await tx.$queryRaw`SELECT id FROM "space_members" WHERE "spaceId" = ${spaceId} AND "userId" = ${run.userId} FOR UPDATE`;
          }
        }
        if (crossSpace) {
          await tx.$queryRaw`SELECT id FROM "bots" WHERE "id" = ${target.id} AND "spaceId" = ${targetSpaceId} AND "userId" = ${run.userId} FOR UPDATE`;
        }
        if (crossSpace && targetBinding?.provenance) {
          await tx.$queryRaw`
            SELECT cgm.id
            FROM "chat_group_members" cgm
            JOIN "chat_groups" cg ON cg.id = cgm."groupId"
            JOIN "threads" t ON t."groupId" = cg.id
            WHERE cgm."botId" = ${target.id}
              AND cg."userId" = ${run.userId}
              AND cg."archivedAt" IS NULL
              AND t.id = ${targetThreadId}
              AND t."spaceId" = ${targetSpaceId}
            FOR UPDATE OF cgm, cg
          `;
        }
        for (const threadId of [run.threadId, targetThreadId].sort()) {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
        }
        // Claim the delivery key inside the transaction so a concurrent retry
        // either sees the winner or loses on the unique (threadId, clientNonce).
        if (deliveryKey) {
          const already = await tx.message.findUnique({
            where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
            select: { id: true },
          });
          if (already) return { ok: true as const, replayed: true as const };
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

        if (crossSpace) {
          const binding = targetBinding!;
          const sourceMembership = await tx.spaceMember.findUnique({
            where: { spaceId_userId: { spaceId: run.spaceId, userId: run.userId } },
            select: {
              organizationId: true,
              space: { select: { id: true, name: true, deletingAt: true } },
            },
          });
          const targetMembership = await tx.spaceMember.findUnique({
            where: {
              spaceId_userId: { spaceId: targetSpaceId, userId: run.userId },
            },
            select: {
              organizationId: true,
              space: { select: { id: true, name: true, deletingAt: true } },
            },
          });
          if (
            !sourceMembership ||
            !targetMembership ||
            sourceMembership.organizationId !== targetMembership.organizationId ||
            sourceMembership.space.deletingAt ||
            targetMembership.space.deletingAt
          ) {
            return {
              ok: false as const,
              error: "The source or destination Space is no longer accessible.",
            };
          }
          if (
            sourceMembership.space.name !== binding.source.spaceName ||
            targetMembership.space.name !== binding.target.spaceName
          ) {
            return {
              ok: false as const,
              error: "A Space name changed after this request was reviewed.",
            };
          }
        }

        // Re-read the target inside the transaction: it can be archived between
        // resolving it above and committing here.
        const stillAddressable = await tx.bot.findFirst({
          where: {
            id: target.id,
            spaceId: targetSpaceId,
            userId: run.userId,
            archivedAt: null,
          },
          select: {
            id: true,
            name: true,
            thread: { select: { id: true, spaceId: true, botId: true } },
          },
        });
        if (!stillAddressable || stillAddressable.name !== target.name) {
          return { ok: false as const, error: `${target.name} is no longer available` };
        }
        let targetThreadIsValid =
          stillAddressable.thread?.id === targetThreadId &&
          stillAddressable.thread.spaceId === targetSpaceId &&
          stillAddressable.thread.botId === target.id;
        if (!targetThreadIsValid && targetBinding?.provenance) {
          const groupMembership = await tx.chatGroupMember.findFirst({
            where: {
              botId: target.id,
              group: {
                userId: run.userId,
                archivedAt: null,
                thread: { is: { id: targetThreadId, spaceId: targetSpaceId } },
              },
            },
            select: { id: true },
          });
          targetThreadIsValid = Boolean(groupMembership);
        }
        if (!targetThreadIsValid) {
          return {
            ok: false as const,
            error: `${target.name} no longer has access to the original thread`,
          };
        }

        // Echo into the sender's chat in the same transaction so a failed notify
        // cannot leave one side delivered and the other blank.
        const outbound = await createThreadMessageInTransaction(tx, {
          threadId: run.threadId,
          role: "bot",
          blocks: [outboundBlock],
          botId: run.botId,
          runId: run.id,
          markUnread: options?.forceUnread === true,
          allowCancelledRun: options?.allowTerminalSource === true,
        });
        const inboundBlock = {
          kind: "bot_message_received",
          fromBotId: sender.id,
          fromBotName: sender.name,
          text: message,
          hop,
          intent,
          returnToMessageId: outbound.id,
          ...(crossSpace
            ? {
                fromSpaceId: targetBinding!.source.spaceId,
                fromSpaceName: targetBinding!.source.spaceName,
                fromThreadId: targetBinding!.source.threadId,
              }
            : {}),
        } as MessageBlock;
        const inbound = await createThreadMessageInTransaction(tx, {
          threadId: targetThreadId,
          role: "user",
          blocks: [inboundBlock],
          replyToMessageId:
            sourceContext?.fromBotId === target.id && intent !== "fyi"
              ? sourceContext.returnToMessageId
              : undefined,
          clientNonce: deliveryKey,
          markUnread: options?.forceUnread === true,
        });
        const task = await tx.task.create({
          data: {
            spaceId: targetSpaceId,
            botId: target.id,
            threadId: targetThreadId,
            userId: run.userId,
            prompt: wakePrompt,
            status: "queued",
          },
        });
        const nextRun = await tx.run.create({
          data: {
            spaceId: targetSpaceId,
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
          spaceId: targetSpaceId,
          threadId: targetThreadId,
          botId: target.id,
          type: "thread.message.created",
          runId: nextRun.id,
          payload: { messageId: inbound.id, role: "user", blocks: [inboundBlock] },
        });
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
      const winner = await deps.prisma.message.findUnique({
        where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
        select: { id: true },
      });
      if (winner) return replayed();
    }
    throw error;
  }
  if ("replayed" in committed) return replayed();
  if (!committed.ok) return committed;

  await deps.events.notify(targetThreadId, committed.targetEventSeq).catch((error) => {
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
    note: `Sent to ${target.name}. Delivery is async; a reply wakes you later as a new message. Continue independent work; send another update later only if it adds something new.`,
  };
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
  const routedSource = source as typeof source & {
    fromSpaceId?: string;
    fromSpaceName?: string;
    fromThreadId?: string;
  };
  const hasCrossSpaceProvenance = Boolean(
    routedSource.fromSpaceId || routedSource.fromSpaceName || routedSource.fromThreadId,
  );
  const finalMessage = clampBotMessage(text);
  const targetBinding = hasCrossSpaceProvenance
    ? await verifyCrossSpaceBotMessageReturn(deps.prisma, run, routedSource, finalMessage, intent)
    : undefined;
  if (hasCrossSpaceProvenance && !targetBinding) {
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
    (Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : []).some((block) => {
      const routed = block as typeof block & { toSpaceId?: string; toThreadId?: string };
      return (
        block.kind === "bot_message_sent" &&
        block.toBotId === source.fromBotId &&
        block.intent === "result" &&
        (!targetBinding ||
          (routed.toSpaceId === targetBinding.target.spaceId &&
            routed.toThreadId === targetBinding.target.threadId))
      );
    }),
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
      confirm_name: targetBinding?.target.botName,
      target_space: targetBinding?.target.spaceId,
      message: finalMessage,
      intent,
      // One key per run so status vs result (executor vs reconciler) cannot double-deliver.
      deliveryKey: `auto-outcome:${run.id}`,
    },
    {
      allowTerminalSource: true,
      forceUnread: options?.forceUnread,
      ...(targetBinding ? { targetBinding } : {}),
    },
  );
  if (outcome.ok) await markBotOutcomeReturned(deps.prisma, run.id);
  return outcome.ok;
}

async function verifyCrossSpaceBotMessageReturn(
  prisma: PrismaClient,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
  },
  context: {
    fromBotId: string;
    fromBotName: string;
    text: string;
    intent?: BotMessageIntent;
    returnToMessageId?: string;
    fromSpaceId?: string;
    fromSpaceName?: string;
    fromThreadId?: string;
  },
  message: string,
  intent: "result" | "status",
): Promise<MessageBotTargetBinding | undefined> {
  if (
    !run.sourceMessageId ||
    !context.fromSpaceId ||
    !context.fromSpaceName ||
    !context.fromThreadId ||
    !context.returnToMessageId ||
    context.fromSpaceId === run.spaceId
  ) {
    return undefined;
  }
  const inbound = await prisma.message.findUnique({
    where: { id: run.sourceMessageId },
    select: {
      role: true,
      runId: true,
      blocks: true,
      thread: { select: { id: true, spaceId: true, botId: true } },
    },
  });
  if (
    inbound?.role !== "user" ||
    inbound.runId !== run.id ||
    inbound.thread.id !== run.threadId ||
    inbound.thread.spaceId !== run.spaceId ||
    inbound.thread.botId !== run.botId
  ) {
    return undefined;
  }
  const inboundContext = botMessageContext(
    Array.isArray(inbound.blocks) ? (inbound.blocks as MessageBlock[]) : [],
  ) as
    | (BotMessageContext & {
        fromSpaceId?: string;
        fromSpaceName?: string;
        fromThreadId?: string;
      })
    | undefined;
  if (
    !inboundContext ||
    inboundContext.fromBotId !== context.fromBotId ||
    inboundContext.fromBotName !== context.fromBotName ||
    inboundContext.text !== context.text ||
    inboundContext.intent !== context.intent ||
    inboundContext.returnToMessageId !== context.returnToMessageId ||
    inboundContext.fromSpaceId !== context.fromSpaceId ||
    inboundContext.fromSpaceName !== context.fromSpaceName ||
    inboundContext.fromThreadId !== context.fromThreadId
  ) {
    return undefined;
  }
  const outbound = await prisma.message.findUnique({
    where: { id: context.returnToMessageId },
    select: {
      role: true,
      botId: true,
      blocks: true,
      thread: { select: { id: true, spaceId: true, botId: true } },
    },
  });
  const outboundBlock = (Array.isArray(outbound?.blocks) ? outbound.blocks : []).find(
    (block) => isRecord(block) && block.kind === "bot_message_sent",
  ) as Record<string, unknown> | undefined;
  if (
    outbound?.role !== "bot" ||
    outbound.botId !== context.fromBotId ||
    outbound.thread.id !== context.fromThreadId ||
    outbound.thread.spaceId !== context.fromSpaceId ||
    (outbound.thread.botId !== context.fromBotId &&
      !(await isBotMemberOfThread(
        prisma,
        context.fromBotId,
        context.fromThreadId,
        context.fromSpaceId,
        run.userId,
      ))) ||
    !outboundBlock ||
    outboundBlock.toBotId !== run.botId ||
    outboundBlock.toSpaceId !== run.spaceId ||
    outboundBlock.toThreadId !== run.threadId ||
    outboundBlock.text !== context.text ||
    outboundBlock.intent !== context.intent
  ) {
    return undefined;
  }
  const [sourceMembership, targetMembership] = await Promise.all([
    prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: run.spaceId, userId: run.userId } },
      select: {
        organizationId: true,
        space: { select: { id: true, name: true, deletingAt: true } },
      },
    }),
    prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: context.fromSpaceId, userId: run.userId } },
      select: {
        organizationId: true,
        space: { select: { id: true, name: true, deletingAt: true } },
      },
    }),
  ]);
  if (
    !sourceMembership ||
    !targetMembership ||
    sourceMembership.organizationId !== targetMembership.organizationId ||
    sourceMembership.space.deletingAt ||
    targetMembership.space.deletingAt ||
    targetMembership.space.name !== context.fromSpaceName ||
    outboundBlock.toSpaceName !== sourceMembership.space.name
  ) {
    return undefined;
  }
  const targetBot = await prisma.bot.findFirst({
    where: {
      id: context.fromBotId,
      spaceId: context.fromSpaceId,
      userId: run.userId,
      archivedAt: null,
    },
    select: { id: true, name: true, thread: { select: { id: true, spaceId: true, botId: true } } },
  });
  if (!targetBot || targetBot.name !== context.fromBotName) return undefined;
  const directThreadMatches =
    targetBot.thread?.id === context.fromThreadId &&
    targetBot.thread.spaceId === context.fromSpaceId &&
    targetBot.thread.botId === context.fromBotId;
  if (
    !directThreadMatches &&
    !(await isBotMemberOfThread(
      prisma,
      context.fromBotId,
      context.fromThreadId,
      context.fromSpaceId,
      run.userId,
    ))
  ) {
    return undefined;
  }
  return {
    source: {
      spaceId: run.spaceId,
      spaceName: sourceMembership.space.name,
      threadId: run.threadId,
      botId: run.botId,
      userId: run.userId,
    },
    target: {
      spaceId: context.fromSpaceId,
      spaceName: context.fromSpaceName,
      botId: context.fromBotId,
      botName: context.fromBotName,
      threadId: context.fromThreadId,
    },
    requested: {
      targetSpace: context.fromSpaceId,
      botId: context.fromBotId,
      confirmName: context.fromBotName,
      message,
      intent,
    },
    provenance: {
      inboundMessageId: run.sourceMessageId,
      outboundMessageId: context.returnToMessageId,
    },
  };
}

async function isBotMemberOfThread(
  prisma: Pick<PrismaClient, "chatGroupMember">,
  botId: string,
  threadId: string,
  spaceId: string,
  userId: string,
) {
  const membership = await prisma.chatGroupMember.findFirst({
    where: {
      botId,
      group: { userId, archivedAt: null, thread: { is: { id: threadId, spaceId } } },
    },
    select: { id: true },
  });
  return Boolean(membership);
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
