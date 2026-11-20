import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import { createAdapterContext, runJobKey } from "@rakazo/adapter-kit";
import type { Actor, HostFrame, HostGrant, HostStart, MessageBlock } from "@rakazo/contracts";
import { HostDispatchSchema } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { HostExecution, Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  cancelRunsInTransaction,
  createThreadMessageInTransaction,
  partialReplyClientNonce,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { wrapJobPayload } from "@rakazo/logging";
import { cancelComputerRunWork, scheduleComputerSleep } from "./../computers/computer-idle.js";
import { toComputerRef } from "./../computers/screens/computer-support.js";
import { persistMessageInTransaction } from "./../runs/assembly/run-messages.js";
import { answerNativeInteraction, updateNativeInteraction } from "./answers.js";

const LEASE_MS = 90_000;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class HostExecutionError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "BAD_REQUEST",
    message = "Local execution unavailable",
  ) {
    super(message);
  }
}
export interface HostExecutionDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  sandbox?: SandboxProvider;
  jobs?: JobPublisher;
}
interface HostActor {
  actor: Actor;
  sessionId?: string;
}

export function hostTokenMatches(saved: string, token: string) {
  const candidate = digest(token);
  return (
    saved.length === candidate.length && timingSafeEqual(Buffer.from(saved), Buffer.from(candidate))
  );
}

/** The delayed job can only expire a desktop run; it can never dispatch its prompt. */
export async function scheduleHostBackup(
  tx: Prisma.TransactionClient,
  runId: string,
  expires: Date,
) {
  const payload = JSON.stringify(wrapJobPayload({ runId }));
  const key = runJobKey(runId);
  const at = new Date(expires.getTime() + 5_000);
  await tx.$executeRaw`SELECT graphile_worker.add_job('run.continue', ${payload}::json, run_at := ${at}, job_key := ${key}, max_attempts := 10)`;
}

function authorize(
  saved: HostExecution | null,
  who: HostActor,
  token: string,
): asserts saved is HostExecution {
  if (
    !saved ||
    !who.sessionId ||
    saved.spaceId !== who.actor.spaceId ||
    saved.userId !== who.actor.userId ||
    saved.authSessionId !== who.sessionId ||
    !hostTokenMatches(saved.tokenHash, token)
  )
    throw new HostExecutionError("FORBIDDEN");
}

export async function authorizedHostExecution(
  deps: HostExecutionDeps,
  who: HostActor,
  grant: HostGrant,
) {
  const saved = await deps.prisma.hostExecution.findUnique({ where: { runId: grant.runId } });
  authorize(saved, who, grant.token);
  const run = await deps.prisma.run.findUniqueOrThrow({
    where: { id: saved.runId },
    include: { bot: true },
  });
  if (
    run.bot.spaceId !== who.actor.spaceId ||
    run.bot.userId !== who.actor.userId ||
    run.bot.archivedAt
  )
    throw new HostExecutionError("FORBIDDEN");
  return { saved, run };
}

export async function startHostExecution(
  deps: HostExecutionDeps,
  who: HostActor,
  input: HostStart,
) {
  if (!who.sessionId) throw new HostExecutionError("FORBIDDEN");
  const { actor, sessionId } = who;
  const threadRef = await deps.prisma.thread.findFirst({
    where: { botId: input.botId, spaceId: actor.spaceId, userId: actor.userId, groupId: null },
    select: { id: true },
  });
  if (!threadRef) throw new HostExecutionError("NOT_FOUND");
  const nonce = `host:${digest([actor.userId, input.botId, input.installationId, input.clientNonce])}`;
  const result = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadRef.id} FOR UPDATE`;
    // Clear may have advanced the history while this start waited for the lock.
    const thread = await tx.thread.findUniqueOrThrow({ where: { id: threadRef.id } });
    const bot = await tx.bot.findFirst({
      where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    });
    if (!bot) throw new HostExecutionError("NOT_FOUND");
    const existing = await tx.run.findUnique({
      where: { spaceId_clientNonce: { spaceId: actor.spaceId, clientNonce: nonce } },
      include: { hostExecution: true, task: true },
    });
    if (existing) {
      authorize(existing.hostExecution, who, input.token);
      if (existing.hostExecution.requestHash !== digest(input))
        throw new HostExecutionError("CONFLICT");
      if (!existing.sourceMessageId) throw new HostExecutionError("CONFLICT");
      if (
        existing.task.prompt !== input.text ||
        existing.hostExecution.installationId !== input.installationId ||
        existing.hostExecution.profileId !== input.profileId ||
        existing.hostExecution.engineVersion !== input.engineVersion
      )
        throw new HostExecutionError("CONFLICT");
      const source = await tx.message.findUniqueOrThrow({
        where: { id: existing.sourceMessageId },
      });
      return {
        run: existing,
        saved: existing.hostExecution,
        cursor: thread.nextEventSeq - 1,
        messageSeq: source.seq,
      };
    }
    if (
      await tx.run.findFirst({ where: { botId: bot.id, status: { in: [...ACTIVE_RUN_STATUSES] } } })
    )
      throw new HostExecutionError(
        "CONFLICT",
        "Stop the current task before starting a local task",
      );
    if (input.target === "computer") {
      const computer = bot.computerId
        ? await tx.computer.findFirst({
            where: {
              id: bot.computerId,
              spaceId: actor.spaceId,
              OR: [{ scope: "team" }, { scope: "personal", userId: actor.userId }],
            },
          })
        : null;
      if (!computer || ["desktop", "user-device"].includes(computer.kind) || bot.computerSwitching)
        throw new HostExecutionError("CONFLICT", "Computer unavailable");
    }
    const bindingKey = digest([
      actor.spaceId,
      actor.userId,
      bot.id,
      thread.id,
      thread.historyCompactionGeneration,
      input.installationId,
      input.profileId,
      input.revision,
      input.engineVersion,
      input.target,
      input.target === "computer" ? bot.computerId : null,
      input.model ?? null,
    ]);
    const latest = await tx.hostExecution.findFirst({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        bindingKey,
      },
      include: { run: { select: { status: true } } },
      orderBy: { createdAt: "desc" },
    });
    const previous =
      latest?.terminal === "completed" && latest.run.status === "completed" && latest.sessionRef
        ? latest
        : null;
    const lastMessage = previous
      ? await tx.message.findFirst({
          where: { runId: previous.runId, threadId: thread.id },
          orderBy: { seq: "desc" },
          select: { seq: true },
        })
      : null;
    const history = await tx.message.findMany({
      where: {
        threadId: thread.id,
        role: { in: ["user", "bot"] },
        ...(lastMessage ? { seq: { gt: lastMessage.seq } } : {}),
      },
      orderBy: { seq: "desc" },
      take: 100,
    });
    let remaining = 200_000;
    const context = history
      .flatMap((message) => {
        if (remaining <= 0) return [];
        const content = (message.blocks as MessageBlock[])
          .filter((b) => b.kind === "text")
          .map((b) => b.text)
          .join("\n")
          .slice(-Math.max(0, remaining));
        remaining -= content.length;
        return content && remaining >= 0
          ? [{ role: message.role === "bot" ? ("assistant" as const) : ("user" as const), content }]
          : [];
      })
      .reverse();
    const dispatch = HostDispatchSchema.parse({
      instructions: bot.instructions,
      context,
      ...(previous?.sessionRef
        ? { session: { id: previous.sessionRef, engineVersion: input.engineVersion } }
        : {}),
    });
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
    const task = await tx.task.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: bot.id,
        threadId: thread.id,
        prompt: input.text,
        status: "running",
      },
    });
    const run = await tx.run.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        trigger: "host",
        status: "running",
        clientNonce: nonce,
        leaseOwner: input.installationId,
        leaseFence: 1,
        leaseExpiresAt,
        startedAt: now,
        attempts: { create: { fence: 1, status: "running" } },
      },
    });
    const message = await createThreadMessageInTransaction(tx, {
      threadId: thread.id,
      role: "user",
      blocks: [{ kind: "text", text: input.text }],
      authorUserId: actor.userId,
      runId: run.id,
      clientNonce: input.clientNonce,
    });
    await tx.run.update({ where: { id: run.id }, data: { sourceMessageId: message.id } });
    await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: thread.id,
      botId: bot.id,
      runId: run.id,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "user", blocks: message.blocks },
    });
    const started = await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: thread.id,
      botId: bot.id,
      runId: run.id,
      type: "run.started",
      payload: { taskId: task.id },
    });
    const saved = await tx.hostExecution.create({
      data: {
        runId: run.id,
        spaceId: actor.spaceId,
        userId: actor.userId,
        authSessionId: sessionId,
        installationId: input.installationId,
        profileId: input.profileId,
        bindingKey,
        generation: randomUUID(),
        tokenHash: digest(input.token),
        requestHash: digest(input),
        engineVersion: input.engineVersion,
        targetComputerId: input.target === "computer" ? bot.computerId : null,
        dispatch,
      },
    });
    await scheduleHostBackup(tx, run.id, leaseExpiresAt);
    return { run, saved, cursor: started.seq, messageSeq: message.seq };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  await deps.events.notify(threadRef.id, result.cursor);
  return {
    runId: result.run.id,
    token: input.token,
    taskId: result.run.taskId,
    seq: result.messageSeq,
    threadId: threadRef.id,
    userId: actor.userId,
    spaceId: actor.spaceId,
    generation: result.saved.generation,
    leaseExpiresAt: (result.run.leaseExpiresAt ?? new Date(0)).toISOString(),
    cursor: result.cursor,
    stopped:
      result.run.status !== "running" ||
      Boolean(result.saved.terminal) ||
      !result.run.leaseExpiresAt ||
      result.run.leaseExpiresAt <= new Date(),
    ...HostDispatchSchema.parse(result.saved.dispatch),
  };
}

export function checkHostFrames(after: number, frames: HostFrame[]) {
  let sequence = after;
  for (const frame of frames) {
    if (frame.sequence <= after) continue;
    if (frame.sequence !== sequence + 1)
      throw new HostExecutionError("CONFLICT", "Execution event gap");
    sequence = frame.sequence;
  }
  return sequence;
}

export async function syncHostExecution(
  deps: HostExecutionDeps,
  who: HostActor,
  input: HostGrant & { frames: HostFrame[] },
) {
  const authorized = await authorizedHostExecution(deps, who, input);
  const result = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${authorized.run.threadId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM runs WHERE id = ${input.runId} FOR UPDATE`;
    const run = await tx.run.findUniqueOrThrow({ where: { id: input.runId } });
    const saved = await tx.hostExecution.findUniqueOrThrow({ where: { runId: input.runId } });
    authorize(saved, who, input.token);
    const now = new Date();
    if (run.status !== "running" || !run.leaseExpiresAt || run.leaseExpiresAt <= now)
      return {
        after: saved.lastSequence,
        leaseExpiresAt: new Date(0).toISOString(),
        stopped: true,
        answers: [],
        seq: undefined,
      };
    checkHostFrames(saved.lastSequence, input.frames);
    let assembled = saved.resultText;
    let terminal = saved.terminal;
    let sequence = saved.lastSequence;
    let seq: number | undefined;
    const base = {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      lease: { owner: saved.installationId, fence: run.leaseFence },
    };
    for (const frame of input.frames) {
      if (frame.sequence <= saved.lastSequence) continue;
      if (terminal) throw new HostExecutionError("CONFLICT");
      const event = frame.event;
      if (event.type === "text") {
        assembled += event.text;
        if (Buffer.byteLength(assembled) > 2 * 1024 * 1024)
          throw new HostExecutionError("BAD_REQUEST", "Execution output too large");
        seq = (
          await appendEventInTransaction(tx, {
            ...base,
            type: "thread.progress",
            payload: { delta: event.text, streaming: true },
          })
        ).seq;
      } else if (event.type === "operation") {
        seq = (
          await appendEventInTransaction(tx, {
            ...base,
            type: "thread.progress",
            payload: { text: event.detail || event.name, activity: true },
          })
        ).seq;
      } else if (event.type === "usage") {
        seq = (
          await appendEventInTransaction(tx, {
            ...base,
            type: "usage.recorded",
            payload: {
              scope: event.scope ?? "run",
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              costUsd: event.costUsd,
            },
          })
        ).seq;
      } else if (event.type === "session") {
        if (event.session.engineVersion !== saved.engineVersion)
          throw new HostExecutionError("BAD_REQUEST");
        await tx.hostExecution.update({
          where: { runId: run.id },
          data: { sessionRef: event.session.id },
        });
      } else if (event.type === "interaction") {
        const message = await persistMessageInTransaction(
          tx,
          run,
          "bot",
          [
            {
              kind: "ask",
              text: event.request.title,
              detail: event.request.detail,
              input: "text",
              actions: event.request.actions,
              nativeRequestId: event.request.id,
              nativeKind: event.request.kind,
              nativeDelivery: "pending",
              status: "pending",
            },
          ],
          true,
          `host:${run.id}:${frame.sequence}`,
          false,
          base.lease,
        );
        await tx.nativeInteraction.create({
          data: {
            id: digest([run.id, event.request.id]),
            spaceId: run.spaceId,
            userId: run.userId,
            runId: run.id,
            requestId: event.request.id,
            generation: saved.generation,
            messageId: message.message.id,
          },
        });
        seq = message.eventSeq;
      } else if (event.type === "interaction_closed") {
        const interaction = await tx.nativeInteraction.findUnique({
          where: { runId_requestId: { runId: run.id, requestId: event.id } },
        });
        if (interaction) seq = (await updateNativeInteraction(tx, interaction, event.status)).seq;
      } else terminal = event.type;
      sequence = frame.sequence;
    }
    const expires = new Date(now.getTime() + LEASE_MS);
    await tx.hostExecution.update({
      where: { runId: run.id },
      data: { lastSequence: sequence, resultText: assembled, terminal },
    });
    await tx.run.update({ where: { id: run.id }, data: { leaseExpiresAt: expires } });
    if (saved.targetComputerId)
      await tx.computerExecutionLease.updateMany({
        where: { runId: run.id, computerId: saved.targetComputerId },
        data: { expiresAt: expires },
      });
    await scheduleHostBackup(tx, run.id, expires);
    const submitted = terminal
      ? []
      : await tx.nativeInteraction.findMany({
          where: { runId: run.id, generation: saved.generation, status: "submitted" },
          include: { message: { select: { blocks: true } } },
        });
    const answers = submitted.flatMap((item) => {
      const block = (item.message.blocks as MessageBlock[]).find(
        (b) => b.kind === "ask" && b.nativeRequestId === item.requestId,
      );
      return block?.kind === "ask" && block.answer !== undefined
        ? [{ requestId: item.requestId, answer: block.answer }]
        : [];
    });
    return {
      after: sequence,
      leaseExpiresAt: expires.toISOString(),
      stopped: Boolean(terminal),
      answers,
      seq,
    };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (result.seq !== undefined) await deps.events.notify(authorized.run.threadId, result.seq);
  if (result.stopped) await finishHostExecution(deps, input.runId);
  return {
    after: result.after,
    leaseExpiresAt: result.leaseExpiresAt,
    stopped: result.stopped,
    answers: result.answers,
  };
}

/** Retrying this only commits a terminal outcome. It never contacts a desktop. */
export async function finishHostExecution(deps: HostExecutionDeps, runId: string) {
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    include: { hostExecution: true, attempts: { where: { status: "running" }, take: 1 } },
  });
  const saved = run?.hostExecution;
  if (!run || !saved) return;
  if (run.status !== "running") {
    const events = await deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM runs WHERE id = ${run.id} FOR UPDATE`;
      const current = await tx.run.findUniqueOrThrow({ where: { id: run.id } });
      const pending = await tx.nativeInteraction.findMany({
        where: { runId, status: { in: ["pending", "submitted"] } },
      });
      const events = [];
      if (
        current.status === "cancelled" &&
        // Clear deletes the source message. Stop alone preserves it and its partial reply.
        current.sourceMessageId &&
        saved.resultText &&
        !(await tx.message.findUnique({
          where: {
            threadId_clientNonce: {
              threadId: run.threadId,
              clientNonce: partialReplyClientNonce(run.id),
            },
          },
        }))
      ) {
        const message = await persistMessageInTransaction(
          tx,
          current,
          "bot",
          [{ kind: "text", text: saved.resultText }],
          true,
          partialReplyClientNonce(run.id),
          true,
        );
        events.push({ seq: message.eventSeq });
      }
      for (const interaction of pending)
        events.push(await updateNativeInteraction(tx, interaction, "expired"));
      return events;
    });
    for (const event of events) await deps.events.notify(run.threadId, event.seq);
    return;
  }
  if (!saved.terminal && run.leaseExpiresAt && run.leaseExpiresAt > new Date()) {
    await deps.prisma.$transaction((tx) => scheduleHostBackup(tx, runId, run.leaseExpiresAt!));
    return;
  }
  if (saved.targetComputerId && deps.sandbox && saved.terminal !== "completed") {
    const computer = await deps.prisma.computer.findUnique({
      where: { id: saved.targetComputerId },
    });
    if (computer?.providerRef)
      await cancelComputerRunWork(deps.sandbox, toComputerRef(computer), computer.id, run.id, {
        ...createAdapterContext(run, run.botId, run.id),
        runId: run.id,
        signal: AbortSignal.timeout(20_000),
      });
  }
  const closed = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM runs WHERE id = ${run.id} FOR UPDATE`;
    if (
      (await tx.run.findUnique({ where: { id: run.id }, select: { status: true } }))?.status !==
      "running"
    )
      return [];
    const pending = await tx.nativeInteraction.findMany({
      where: { runId, status: { in: ["pending", "submitted"] } },
    });
    const events = [];
    for (const interaction of pending)
      events.push(await updateNativeInteraction(tx, interaction, "expired"));
    if (saved.terminal === "cancelled") {
      if (saved.resultText) {
        const message = await persistMessageInTransaction(
          tx,
          run,
          "bot",
          [{ kind: "text", text: saved.resultText }],
          true,
          partialReplyClientNonce(run.id),
          true,
        );
        events.push({ seq: message.eventSeq });
      }
      if ((await cancelRunsInTransaction(tx, [run], new Date())).length)
        events.push(
          await appendEventInTransaction(tx, {
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            runId,
            type: "run.cancelled",
            payload: {},
            allowCancelledRun: true,
          }),
        );
    }
    return events;
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  for (const event of closed) await deps.events.notify(run.threadId, event.seq);
  if (saved.terminal !== "cancelled" && run.attempts[0] && run.leaseOwner) {
    const blocks: MessageBlock[] = saved.resultText
      ? [{ kind: "text", text: saved.resultText }]
      : [];
    await deps.events.finalizeRun({
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId,
      taskId: run.taskId,
      attemptId: run.attempts[0].id,
      leaseOwner: run.leaseOwner,
      leaseFence: run.leaseFence,
      ...(saved.terminal === "completed"
        ? { outcome: "completed" as const, blocks }
        : {
            outcome: "failed" as const,
            error: saved.terminal
              ? "The local execution failed. Review its activity before retrying."
              : "The desktop disconnected. Review the local workspace before retrying.",
            partialReply: blocks,
          }),
    });
  }
  if (saved.targetComputerId) {
    await deps.prisma.computerExecutionLease.updateMany({
      where: { runId: run.id, computerId: saved.targetComputerId },
      data: { expiresAt: new Date(0) },
    });
    if (deps.jobs) scheduleComputerSleep(deps.jobs, saved.targetComputerId);
  }
  const key = runJobKey(runId);
  await deps.prisma.$executeRaw`SELECT graphile_worker.remove_job(${key})`;
}

export async function answerHostExecution(
  deps: HostExecutionDeps,
  who: HostActor,
  input: HostGrant & { messageId: string; answer: string },
) {
  const { saved, run } = await authorizedHostExecution(deps, who, input);
  if (saved.terminal) return { ok: false };
  if (run.status !== "running" || !run.leaseExpiresAt || run.leaseExpiresAt <= new Date())
    return { ok: false };
  return {
    ok: Boolean(
      await answerNativeInteraction(deps, {
        spaceId: who.actor.spaceId,
        userId: who.actor.userId,
        threadId: run.threadId,
        runId: run.id,
        messageId: input.messageId,
        answer: input.answer,
        hostAuthorized: true,
      }),
    ),
  };
}
