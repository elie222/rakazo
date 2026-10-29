import { ORPCError } from "@orpc/server";
import { runContinueJob, runJobKey } from "@rakazo/adapter-kit";
import { settleCallRequest } from "@rakazo/adapters";
import type { ProductEvent } from "@rakazo/contracts";
import {
  CALL_CLIENT_NONCE_PREFIX,
  callClientNonce,
  MODEL_REQUIRED_SEND_ERROR,
  QUEUE_HOLDING_RUN_STATUSES,
} from "@rakazo/core";
import {
  AnswerTooLongError,
  appendEventInTransaction,
  createExternalConversationRepos,
  createThreadMessageInTransaction,
  IsolationError,
  lockOwnedGroup,
  touchGroupUpdatedAt,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { assertTeachingSendAllowed } from "../taught-skills.js";
import {
  isBackgroundRun,
  isPeerRun,
  loadMessagePage,
  shouldForwardBackgroundThreadEvent,
  shouldForwardPeerThreadEvent,
} from "../thread-message-pages.js";
import {
  markThreadRead,
  markThreadUnreadFrom,
  reactToThreadMessage,
  resolveThreadTarget,
  sendThreadMessage,
  setThreadUnreadState,
  stopThreadRuns,
  threadHead,
  threadSnapshot,
} from "../thread-target.js";
import { mapBotSecretInputError } from "./bots.js";
import { releaseComputerControl } from "./computer.js";
import type { RouterContext } from "./context.js";
import {
  computerContext,
  HEARTBEAT_MS,
  isUniqueViolation,
  modelSetup,
  SESSION_RECHECK_MS,
  THREAD_MESSAGE_PAGE_SIZE,
} from "./shared.js";

/** Deterministic nonce for a call's marker message. The unique (threadId, clientNonce)
 * index makes it the hang-up idempotency key, and the "call:" prefix lets clients derive
 * the marker's callId. User turns carry a uuid suffix, so they never collide. */
export function callMarkerClientNonce(callId: string): string {
  return `${CALL_CLIENT_NONCE_PREFIX}${callId}:marker`;
}

/** The card is closed by a marker; the run that follows finishes whatever the call left open. */
const HANG_UP_PROMPT =
  "The voice call just ended because the user hung up. First call end_call with a short title for the call (leave farewell empty). Then, if anything the user asked for during the call is still unfinished, complete it now as a normal chat reply with full formatting. If nothing is pending, reply with one short sentence.";

export function threadsRoutes(ctx: RouterContext) {
  const { deps, authed, callsEnabled, codexCatalog } = ctx;
  return {
    threads: {
      head: authed.threads.head.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        return threadHead(deps.prisma, target);
      }),
      get: authed.threads.get.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input, {
          includeArchived: true,
        });
        return threadSnapshot(deps, target);
      }),
      messages: authed.threads.messages.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input, {
          includeArchived: true,
        });
        return loadMessagePage(
          deps.prisma,
          target.threadId,
          input.before,
          THREAD_MESSAGE_PAGE_SIZE,
          input.around,
          input.includePeerRuns,
          input.includePeerReceipts,
        );
      }),
      subscribe: authed.threads.subscribe.handler(async function* ({ context, input }) {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const peerRunCache = new Map<string, Promise<boolean>>();
        const backgroundRunCache = new Map<string, Promise<boolean>>();
        const follow = deps.events.follow(target.threadId, input.cursor, context.signal);
        // A half-open stream looks identical to an idle one, so punctuate silence:
        // the client treats any frame as liveness and reconnects once they stop.
        let pending: Promise<IteratorResult<ProductEvent>> | undefined;
        // Auth ran once when the stream opened. Re-check before delivering more, so a signed-out
        // or revoked session stops within SESSION_RECHECK_MS, or at the next heartbeat when idle.
        let authorizedAt = Date.now();
        const assertStillAuthorized = async () => {
          if (!context.stillAuthorized || Date.now() - authorizedAt < SESSION_RECHECK_MS) return;
          if (!(await context.stillAuthorized())) throw new ORPCError("UNAUTHORIZED");
          authorizedAt = Date.now();
        };
        try {
          while (!context.signal?.aborted) {
            pending ??= follow.next();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const next = await Promise.race([
              pending,
              new Promise<"silent">((resolve) => {
                timer = setTimeout(() => resolve("silent"), HEARTBEAT_MS);
              }),
            ]).finally(() => clearTimeout(timer));
            if (next === "silent") {
              await assertStillAuthorized();
              // Keep `pending` so the in-flight read stays the next event in order.
              yield {
                id: "heartbeat",
                spaceId: context.actor.spaceId,
                threadId: target.threadId,
                // A bot thread's id is not the bot. Groups have no single bot, so the thread id stands in.
                botId: target.kind === "bot" ? target.botId : target.threadId,
                seq: 0,
                type: "heartbeat",
                createdAt: new Date().toISOString(),
                payload: {},
              };
              continue;
            }
            pending = undefined;
            if (next.done) return;
            const event = next.value;
            // Filtered peer events also restart the heartbeat, so check before skipping them.
            await assertStillAuthorized();
            if (await isPeerRun(deps.prisma, event.runId, peerRunCache)) {
              if (!shouldForwardPeerThreadEvent(event)) continue;
            } else if (await isBackgroundRun(deps.prisma, event.runId, backgroundRunCache)) {
              if (!shouldForwardBackgroundThreadEvent(event)) continue;
            }
            yield event;
          }
        } finally {
          // Not awaited: closing can queue behind a read that the abort has not landed on yet.
          void follow.return(undefined).catch(() => {});
        }
      }),
      send: authed.threads.send.handler(async ({ context, input }) => {
        const setup = await modelSetup(deps, context.actor);
        if (setup.needsModel) {
          throw new ORPCError("BAD_REQUEST", { message: MODEL_REQUIRED_SEND_ERROR });
        }
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        if (target.kind === "bot") {
          await assertTeachingSendAllowed(deps.prisma, context.actor.spaceId, target.botId);
        }
        const confirmingImages =
          input.imageHandling === "confirm" && Boolean(input.artifactIds?.length);
        // Reuse the funding modelSetup resolved; a send never asks billing twice.
        const { funding } = setup;
        const deployment = setup.hasDeployment
          ? { provider: deps.env.defaultProvider, model: deps.env.defaultModel }
          : null;
        return sendThreadMessage(
          {
            ...deps,
            imageAdmission: confirmingImages
              ? {
                  secrets: deps.secrets,
                  deployment,
                  hostedProvider: funding?.funding === "credits" ? deployment?.provider : undefined,
                  codexCatalog,
                }
              : undefined,
          },
          context.actor,
          target,
          input,
          target.kind === "bot"
            ? (runId) => releaseComputerControl(deps, context.actor, target.botId, "done", runId)
            : undefined,
        );
      }),
      react: authed.threads.react.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        // Without a model or while teaching, the reaction is still saved; it just starts no turn.
        const mayStartTurn =
          !(await modelSetup(deps, context.actor)).needsModel &&
          (target.kind !== "bot" ||
            (await assertTeachingSendAllowed(deps.prisma, context.actor.spaceId, target.botId).then(
              () => true,
              () => false,
            )));
        const result = await reactToThreadMessage(
          deps,
          context.actor,
          target,
          { ...input, mayStartTurn },
          target.kind === "bot"
            ? (runId) => releaseComputerControl(deps, context.actor, target.botId, "done", runId)
            : undefined,
        );
        if (result.eventSeq != null) {
          await deps.events.notify(target.threadId, result.eventSeq).catch((error) => {
            getLogger().error("thread reaction realtime notification", error);
          });
        }
        return { ok: true as const, runIds: result.runIds };
      }),
      stop: authed.threads.stop.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        await stopThreadRuns(deps, context.actor, target);
        return { ok: true as const };
      }),
      clear: authed.threads.clear.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const contextBotId = target.kind === "bot" ? target.botId : target.memberBotIds[0];
        if (!contextBotId) throw new IsolationError();
        const { cancelledRunIds, historyCompactionGeneration } = await deps.events.clearThread({
          spaceId: context.actor.spaceId,
          threadId: target.threadId,
          botId: contextBotId,
          ...(target.kind === "group" ? { groupId: target.groupId } : {}),
        });
        const [configuredMemory] = await Promise.all([
          target.kind === "bot"
            ? deps.memoryProviders.resolve(context.actor.spaceId).catch((error) => {
                getLogger().error("semantic memory resolution after thread clear failed", error);
                return null;
              })
            : Promise.resolve(null),
          Promise.all(
            cancelledRunIds.map((runId) =>
              deps.jobs.cancel(runJobKey(runId)).catch(() => undefined),
            ),
          ),
        ]);
        // Durable memories remain in their Space-private containers. Clear only removes
        // conversation-derived summaries from the previous generation; including the new
        // generation also covers a compaction job that began just after the clear committed.
        if (configuredMemory && target.kind === "bot") {
          // Best effort: the conversation rows are already deleted, so failing the clear here
          // would help nothing — a failed purge only leaves stale summaries recallable.
          try {
            const purged = await configuredMemory.provider.purgeHistory(
              {
                botId: target.botId,
                generations: [
                  Math.max(0, historyCompactionGeneration - 1),
                  historyCompactionGeneration,
                ],
              },
              computerContext(context.actor, target.botId, `thread-clear:${target.threadId}`),
            );
            if (!purged.ok) {
              getLogger().error("semantic memory purge after thread clear failed", purged.error);
            }
          } catch (error) {
            getLogger().error("semantic memory purge after thread clear failed", error);
          }
        }
        return { ok: true as const };
      }),
      followUp: authed.threads.followUp.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        if (target.kind === "bot") {
          await assertTeachingSendAllowed(deps.prisma, context.actor.spaceId, target.botId);
          const sent = await deps.events.sendUserMessage({
            spaceId: context.actor.spaceId,
            threadId: target.threadId,
            botId: target.botId,
            userId: context.actor.userId,
            blocks: [{ kind: "text", text: input.text }],
            prompt: input.text,
            trigger: "follow_up",
            clientNonce: input.clientNonce,
          });
          if (sent.taskId && sent.runId) {
            await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
              getLogger().error("follow-up enqueue", error);
            });
          }
          return { ok: true as const };
        }
        const committed = await deps.prisma.$transaction(async (tx) => {
          if (input.clientNonce) {
            const existing = await tx.message.findUnique({
              where: {
                threadId_clientNonce: { threadId: target.threadId, clientNonce: input.clientNonce },
              },
            });
            if (existing) return null;
          }
          await lockOwnedGroup(tx, context.actor, target.groupId);
          const group = await tx.chatGroup.findFirst({
            where: {
              id: target.groupId,
              archivedAt: null,
              thread: { id: target.threadId },
            },
            include: { members: { orderBy: [{ createdAt: "asc" }, { botId: "asc" }] } },
          });
          const botId = group?.members[0]?.botId;
          if (!botId) throw new IsolationError();
          const blocks = [{ kind: "text" as const, text: input.text }];
          const message = await createThreadMessageInTransaction(tx, {
            threadId: target.threadId,
            role: "user",
            blocks,
            clientNonce: input.clientNonce,
          });
          const active = await tx.run.findFirst({
            where: {
              threadId: target.threadId,
              botId,
              status: { in: [...QUEUE_HOLDING_RUN_STATUSES] },
            },
            select: { id: true },
          });
          let run: { id: string } | null = null;
          if (!active) {
            const task = await tx.task.create({
              data: {
                spaceId: context.actor.spaceId,
                botId,
                threadId: target.threadId,
                userId: context.actor.userId,
                prompt: input.text,
                status: "queued",
              },
            });
            run = await tx.run.create({
              data: {
                spaceId: context.actor.spaceId,
                botId,
                threadId: target.threadId,
                taskId: task.id,
                userId: context.actor.userId,
                status: "queued",
                trigger: "follow_up",
                sourceMessageId: message.id,
              },
              select: { id: true },
            });
            await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
          } else {
            await tx.steeringMessage.create({
              data: {
                messageId: message.id,
                botId,
                userId: context.actor.userId,
                runId: active.id,
              },
            });
            await tx.message.update({ where: { id: message.id }, data: { runId: active.id } });
          }
          const event = await appendEventInTransaction(tx, {
            spaceId: context.actor.spaceId,
            threadId: target.threadId,
            botId,
            type: "thread.message.created",
            runId: run?.id ?? active?.id,
            payload: { messageId: message.id, role: "user", blocks },
          });
          await touchGroupUpdatedAt(tx, target.groupId);
          return { runId: run?.id, eventSeq: event.seq, message };
        });
        if (committed) {
          deps.analytics?.capture(
            context.actor.userId,
            { name: "message_sent", trigger: "follow_up" },
            { id: committed.message.id, at: committed.message.createdAt },
          );
          await deps.events.notify(target.threadId, committed.eventSeq).catch((error) => {
            getLogger().error("group follow-up realtime notification", error);
          });
          if (committed.runId) {
            await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
              getLogger().error("group follow-up enqueue", error);
            });
          }
        }
        return { ok: true as const };
      }),
      answerCall: callsEnabled.threads.answerCall.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        if (target.kind !== "bot") throw new IsolationError();
        const answered = await settleCallRequest(deps, {
          threadId: target.threadId,
          callId: input.callId,
          from: ["ringing"],
          status: "answered",
        });
        if (answered?.status !== "answered")
          throw new ORPCError("CONFLICT", { message: "This call is no longer ringing." });
        return { opening: answered.opening, reason: answered.reason };
      }),
      declineCall: callsEnabled.threads.declineCall.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        if (target.kind !== "bot") throw new IsolationError();
        await settleCallRequest(deps, {
          threadId: target.threadId,
          callId: input.callId,
          from: ["ringing"],
          status: input.outcome,
        });
        return { ok: true as const };
      }),
      endCall: callsEnabled.threads.endCall.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        if (target.kind !== "bot") throw new IsolationError();
        await assertTeachingSendAllowed(deps.prisma, context.actor.spaceId, target.botId);
        const { botId, threadId } = target;
        // The bot's own call: its card keeps how long the user stayed on.
        await settleCallRequest(deps, {
          threadId,
          callId: input.callId,
          from: ["answered"],
          ...(input.durationSeconds === undefined
            ? {}
            : { durationSeconds: input.durationSeconds }),
        });
        const blocks = [
          {
            kind: "voice_call" as const,
            callId: input.callId,
            title: "",
            farewell: "",
            ...(input.durationSeconds === undefined
              ? {}
              : { durationSeconds: input.durationSeconds }),
          },
        ];
        const committed = await deps.prisma
          .$transaction(async (tx) => {
            // A late provider hang-up is harmless when the call never produced a
            // user utterance; do not create a phantom marker or follow-up run.
            const userUtterance = await tx.message.findFirst({
              where: {
                threadId,
                role: "user",
                clientNonce: { startsWith: `${CALL_CLIENT_NONCE_PREFIX}${input.callId}:` },
              },
              select: { id: true },
            });
            if (!userUtterance) return null;
            // The marker's deterministic nonce is the idempotency key: the unique
            // (threadId, clientNonce) index rejects a second hang-up, concurrent or not.
            const message = await createThreadMessageInTransaction(tx, {
              threadId,
              role: "bot",
              botId,
              blocks,
              clientNonce: callMarkerClientNonce(input.callId),
            });
            await appendEventInTransaction(tx, {
              spaceId: context.actor.spaceId,
              threadId,
              botId,
              type: "thread.message.created",
              payload: { messageId: message.id, role: "bot", blocks, callId: input.callId },
            });
            const task = await tx.task.create({
              data: {
                spaceId: context.actor.spaceId,
                botId,
                threadId,
                userId: context.actor.userId,
                prompt: HANG_UP_PROMPT,
                status: "queued",
              },
            });
            const run = await tx.run.create({
              data: {
                spaceId: context.actor.spaceId,
                botId,
                threadId,
                taskId: task.id,
                userId: context.actor.userId,
                status: "queued",
                trigger: "call_end",
                clientNonce: callClientNonce(input.callId),
              },
              select: { id: true },
            });
            const ended = await appendEventInTransaction(tx, {
              spaceId: context.actor.spaceId,
              threadId,
              botId,
              type: "thread.call.ended",
              runId: run.id,
              payload: {
                botId,
                threadId,
                callId: input.callId,
                title: "",
                farewell: "",
                messageId: message.id,
              },
            });
            return { runId: run.id, eventSeq: ended.seq };
          })
          .catch((error) => {
            if (!isUniqueViolation(error)) throw error;
            return null;
          });
        if (!committed) return { ok: true as const };
        await deps.events.notify(threadId, committed.eventSeq).catch((error) => {
          getLogger().error("call end realtime notification", error);
        });
        // The queued run is durable; a missed wake is repaired by the reconciler.
        await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
          getLogger().error("call end enqueue", error);
        });
        return { ok: true as const };
      }),
      answer: authed.threads.answer.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const answered = await deps.events
          .answerRunInput({
            spaceId: context.actor.spaceId,
            threadId: target.threadId,
            runId: input.runId,
            messageId: input.messageId,
            answeredByUserId: context.actor.userId,
            answer: input.answer,
            clientNonce: input.clientNonce,
            fields: input.fields,
            username: input.username,
            remember: input.remember,
            dismiss: input.dismiss,
          })
          .catch((error: unknown) => {
            if (error instanceof AnswerTooLongError)
              throw new ORPCError("BAD_REQUEST", { message: error.message });
            // A typed credential its destination cannot carry (e.g. a header with a line break).
            throw mapBotSecretInputError(error);
          });
        if (!answered) {
          throw new ORPCError("CONFLICT", {
            message: "This prompt is no longer awaiting an answer",
          });
        }
        await deps.jobs.enqueue(runContinueJob(input.runId)).catch((error) => {
          // The answer and queued run are durable; the reconciler repairs a missed immediate wake.
          getLogger().error("thread answer enqueue", error);
        });
        return { ok: true as const };
      }),
      markRead: authed.threads.markRead.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const unreadAfterSeq = await markThreadRead(deps.prisma, context.actor, target);
        return { ok: true as const, unreadAfterSeq };
      }),
      markUnread: authed.threads.markUnread.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        if (input.messageId) {
          await markThreadUnreadFrom(deps.prisma, context.actor, target, input.messageId);
        } else {
          await setThreadUnreadState(deps.prisma, context.actor, target, true);
        }
        return { ok: true as const };
      }),
    },
    externalConversations: {
      updatePolicy: authed.externalConversations.updatePolicy.handler(
        async ({ context, input }) => {
          const { externalConversationId, ...policy } = input;
          return createExternalConversationRepos(deps.prisma).updatePolicy(
            context.actor,
            externalConversationId,
            policy,
          );
        },
      ),
    },
  };
}
