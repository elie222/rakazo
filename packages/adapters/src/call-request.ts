import { randomUUID } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { callExpireJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { CallRequestBlock } from "@rakazo/core";
import {
  CALL_CLIENT_NONCE_PREFIX,
  callIdFromClientNonce,
  callRequestBlock,
  callRequestClientNonce,
  phoneCallSettings,
} from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  runAsSystem,
} from "@rakazo/db";
import type { ExecutorDeps } from "./executor-deps.js";
import { isUniqueViolation, publishMessage } from "./run-messages.js";

const REASON_MAX = 120;
const OPENING_MAX = 240;

type CallRequestStatus = CallRequestBlock["status"];

/** Why the bot may not ring the user right now, or null when it may. */
export async function callRequestRefusal(
  prisma: Pick<PrismaClient, "message" | "userVoiceCredential">,
  input: { userId: string; groupChat: boolean; now?: number; phoneCallCooldownMinutes?: number },
): Promise<string | null> {
  if (input.groupChat) return "Calls work in a one-to-one chat only. Send a message instead.";
  const voice = await prisma.userVoiceCredential.findFirst({
    where: { userId: input.userId },
    select: { id: true },
  });
  if (!voice) {
    return "The user has not connected a voice provider, so they cannot take a call. Send a message instead.";
  }
  const minutes = input.phoneCallCooldownMinutes ?? phoneCallSettings().phoneCallCooldownMinutes;
  const since = new Date((input.now ?? Date.now()) - minutes * 60_000);
  const recent = await prisma.message.findFirst({
    where: {
      thread: { userId: input.userId },
      role: "bot",
      clientNonce: { startsWith: CALL_CLIENT_NONCE_PREFIX, endsWith: ":request" },
      createdAt: { gt: since },
    },
    select: { id: true },
  });
  if (recent) {
    return `You already called the user in the last ${minutes} ${minutes === 1 ? "minute" : "minutes"}. Send a message instead of calling again.`;
  }
  return null;
}

export function newCallRequest(input: {
  reason: string;
  opening: string;
  now?: number;
  phoneCallRingSeconds?: number;
}):
  | { error: string }
  | { callId: string; clientNonce: string; expiresAt: Date; blocks: MessageBlock[] } {
  const reason = input.reason.trim().slice(0, REASON_MAX);
  const opening = input.opening.trim().slice(0, OPENING_MAX);
  if (!reason) return { error: "reason is required." };
  if (!opening) return { error: "opening is required." };
  const callId = randomUUID();
  const expiresAt = new Date(
    (input.now ?? Date.now()) +
      (input.phoneCallRingSeconds ?? phoneCallSettings().phoneCallRingSeconds) * 1000,
  );
  return {
    callId,
    clientNonce: callRequestClientNonce(callId),
    expiresAt,
    blocks: [
      {
        kind: "call_request",
        callId,
        reason,
        opening,
        status: "ringing",
        expiresAt: expiresAt.toISOString(),
      },
    ],
  };
}

/**
 * Moves the bot's call on from one of `from` and tells the thread. Returns the
 * updated block, or null when the call is unknown or already moved on, so two
 * devices answering, or an answer racing the ring-out, settle exactly once.
 */
export async function settleCallRequest(
  deps: { prisma: PrismaClient; events: Pick<ThreadEvents, "notify"> },
  input: {
    threadId: string;
    callId: string;
    from: CallRequestStatus[];
    status?: CallRequestStatus;
    durationSeconds?: number;
  },
): Promise<CallRequestBlock | null> {
  const result = await deps.prisma.$transaction(async (tx) => {
    // Match clearThread: thread first, then messages.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const message = await tx.message.findUnique({
      where: {
        threadId_clientNonce: {
          threadId: input.threadId,
          clientNonce: callRequestClientNonce(input.callId),
        },
      },
      select: { id: true, blocks: true, botId: true, thread: { select: { spaceId: true } } },
    });
    if (!message?.botId) return null;
    const before = Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : [];
    const block = callRequestBlock(before);
    if (!block || !input.from.includes(block.status)) return null;
    const expired = block.status === "ringing" && Date.parse(block.expiresAt) <= Date.now();
    const next: CallRequestBlock = {
      ...block,
      ...(input.status ? { status: expired ? "missed" : input.status } : {}),
      ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
    };
    const blocks = [next, ...before.slice(1)];
    // Compare-and-set on the stored status (a plaintext copy beside the encrypted
    // block): a concurrent settle leaves this one a no-op.
    const updated = await tx.message.updateMany({
      where: { id: message.id, blocks: { path: ["0", "status"], equals: block.status } },
      data: { blocks: blocks as Prisma.InputJsonValue },
    });
    if (updated.count !== 1) return null;
    const event = await appendEventInTransaction(tx, {
      spaceId: message.thread.spaceId,
      threadId: input.threadId,
      botId: message.botId,
      type: "thread.message.updated",
      payload: { messageId: message.id, role: "bot", blocks, callId: input.callId },
    });
    return { next, eventSeq: event.seq };
  });
  if (!result) return null;
  await deps.events.notify(input.threadId, result.eventSeq).catch(() => undefined);
  return result.next;
}

/** Serialize ringing across every bot owned by the user, including concurrent runs. */
export async function requestUserCall(
  deps: {
    prisma: PrismaClient;
    events: ThreadEvents;
    jobs: JobPublisher;
    phoneCallsEnabled?: boolean;
    phoneCallCooldownMinutes?: number;
    phoneCallRingSeconds?: number;
  },
  run: { id: string; spaceId: string; userId: string; threadId: string; botId: string },
  input: { reason: string; opening: string },
) {
  if (!deps.phoneCallsEnabled) return { error: "Calls are disabled." };
  const request = newCallRequest({ ...input, phoneCallRingSeconds: deps.phoneCallRingSeconds });
  if ("error" in request) return request;
  // The call cooldown is per person across all their Spaces; every other read and
  // write here names the run's own thread.
  const result = await runAsSystem("check the call cooldown across the user's Spaces", () =>
    deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`call:${run.userId}`}, 0))::text`;
      const target = await tx.thread.findFirst({
        where: {
          id: run.threadId,
          spaceId: run.spaceId,
          userId: run.userId,
          botId: run.botId,
          groupId: null,
          externalConversationId: null,
          bot: { userId: run.userId, spaceId: run.spaceId, archivedAt: null },
        },
        select: { id: true },
      });
      if (!target) return { error: "Calls require the bot's own one-to-one chat." };
      const refusal = await callRequestRefusal(tx, {
        ...run,
        groupChat: false,
        phoneCallCooldownMinutes: deps.phoneCallCooldownMinutes,
      });
      if (refusal) return { error: refusal };
      const message = await createThreadMessageInTransaction(tx, {
        threadId: run.threadId,
        botId: run.botId,
        runId: run.id,
        role: "bot",
        blocks: request.blocks,
        clientNonce: request.clientNonce,
        markUnread: true,
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        runId: run.id,
        type: "thread.message.created",
        payload: {
          messageId: message.id,
          role: "bot",
          blocks: request.blocks,
          callId: request.callId,
        },
      });
      return { eventSeq: event.seq, firstResponseRunId: event.firstResponse ? run.id : undefined };
    }),
  );
  if ("error" in result) return result;
  await deps.events
    .notify(run.threadId, result.eventSeq, result.firstResponseRunId)
    .catch(() => undefined);
  try {
    await deps.jobs.enqueue(callExpireJob(run.threadId, request.callId, request.expiresAt));
  } catch {
    // Fail closed immediately; the reconciler retries any interrupted settlement.
    await settleCallRequest(deps, {
      threadId: run.threadId,
      callId: request.callId,
      from: ["ringing"],
      status: "missed",
    });
    return { error: "Could not ring the user. Send a message instead." };
  }
  return { ok: true, status: "ringing" };
}

/** Restore expiry jobs after a process interruption between persistence and enqueue. */
export async function reconcileCallRequests(deps: { prisma: PrismaClient; jobs: JobPublisher }) {
  const messages = await deps.prisma.message.findMany({
    where: {
      role: "bot",
      clientNonce: { startsWith: CALL_CLIENT_NONCE_PREFIX, endsWith: ":request" },
      blocks: { path: ["0", "status"], equals: "ringing" },
    },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: { threadId: true, blocks: true },
  });
  for (const message of messages) {
    const block = callRequestBlock(message.blocks as MessageBlock[]);
    if (block)
      await deps.jobs.enqueue(
        callExpireJob(message.threadId, block.callId, new Date(block.expiresAt)),
      );
  }
}

/** end_call: titles the call's chat marker and records that the call ended. */
export async function endCallFromTool(
  deps: ExecutorDeps,
  run: { id: string; spaceId: string; threadId: string; botId: string; trigger: string },
  threadId: string,
  botId: string,
  args: Record<string, unknown>,
  callClientNonceForRun: string | null | undefined,
  callEndRun: boolean,
) {
  const callId = callIdFromClientNonce(callClientNonceForRun);
  const title = String(args.title ?? "")
    .trim()
    .slice(0, 40);
  const farewell = String(args.farewell ?? "")
    .trim()
    .slice(0, 160);
  // The client may have hung up first and already closed the card: title that
  // marker instead of leaving a second one behind. The marker's deterministic
  // nonce is the idempotency key, so a resumed run cannot double-publish.
  const nonce = callId ? `${CALL_CLIENT_NONCE_PREFIX}${callId}:marker` : undefined;
  const findMarker = async () =>
    nonce
      ? await deps.prisma.message.findUnique({
          where: { threadId_clientNonce: { threadId: threadId, clientNonce: nonce } },
          select: { id: true, blocks: true },
        })
      : null;
  let existing = await findMarker();
  let markerId = "";
  let changed = true;
  if (!existing) {
    try {
      const marker = await publishMessage(
        deps,
        run,
        "bot",
        [{ kind: "voice_call", ...(callId ? { callId } : {}), title, farewell }],
        true,
        nonce,
      );
      markerId = marker?.id ?? "";
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      existing = await findMarker();
    }
  }
  if (existing) {
    const before = Array.isArray(existing.blocks) ? (existing.blocks as MessageBlock[]) : [];
    const blocks = before.map((block) =>
      block.kind === "voice_call" && block.callId === callId
        ? { ...block, title, ...(farewell ? { farewell } : {}) }
        : block,
    );
    changed = JSON.stringify(blocks) !== JSON.stringify(before);
    if (changed) {
      await deps.prisma.message.update({
        where: { id: existing.id },
        data: { blocks: blocks as Prisma.InputJsonValue },
      });
      await deps.events.append({
        spaceId: run.spaceId,
        threadId: threadId,
        botId,
        runId: run.id,
        type: "thread.message.updated",
        payload: { messageId: existing.id, role: "bot", blocks, callId },
      });
    }
    markerId = existing.id;
  }
  if (changed) {
    await deps.events.append({
      spaceId: run.spaceId,
      threadId: threadId,
      botId,
      runId: run.id,
      type: "thread.call.ended",
      payload: {
        botId,
        threadId: threadId,
        runId: run.id,
        callId,
        title,
        farewell,
        messageId: markerId,
      },
    });
  }
  return {
    ok: callEndRun
      ? "The call is already closed and now carries your title. The user is reading, not listening: finish any remaining work as a normal chat reply with full formatting."
      : "Call ended and your farewell was spoken. The user is now reading, not listening: finish any remaining work as a normal chat reply with full formatting.",
  };
}
