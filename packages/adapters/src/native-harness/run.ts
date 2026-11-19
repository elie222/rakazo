import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  NativeExecutionControl,
  NativeExecutionEvent,
  NativeExecutionSnapshot,
  NativeExecutionStart,
} from "@rakazo/adapter-kit";
import { createAdapterContext } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { BACKGROUND_HELPER_TRIGGER, messageBlockForArtifact, redactSecrets } from "@rakazo/core";
import type { BotExecution, NativeExecution, Run } from "@rakazo/db";
import {
  appendEventInTransaction,
  assertRunCanWriteHistory,
  RunHistoryWriteError,
} from "@rakazo/db";
import { executionStartSchema } from "@rakazo/native-runtime/wire";
import { returnBotMessageOutcome } from "./../messaging/bot-messages.js";
import { provisionComputer } from "./../computers/computer-lifecycle.js";
import type { ExecutorDeps } from "./../runs/executor/executor-deps.js";
import { enqueueSteeringContinuation, failRunBeforeTurn } from "./../runs/lifecycle/run-lifecycle.js";
import { persistMessageInTransaction } from "./../runs/assembly/run-messages.js";
import { attachWorkspaceFileToThread } from "./../storage/thread-artifacts.js";
import { updateNativeInteraction } from "./answers.js";
import { executeNativeBridgeTool } from "./bridge.js";
import { executionConnectionClient } from "./connection.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const leaseExpiry = () => new Date(Date.now() + 240_000).toISOString();

/** Entered before any built-in model or checkpoint resolution. Every trigger uses this route. */
export async function continueNativeRun(
  deps: ExecutorDeps,
  run: Run & {
    nativeExecution: NativeExecution | null;
    bot: { executionConfiguration: BotExecution | null };
  },
  attempt: { id: string; workerId: string; fence: number },
  valid: () => boolean,
): Promise<boolean> {
  let saved = run.nativeExecution;
  const configuration = run.bot.executionConfiguration;
  if (!saved && !configuration) return false;
  const bot = await deps.prisma.bot.findUniqueOrThrow({ where: { id: run.botId } });
  const fail = (message: string) =>
    failRunBeforeTurn(deps, run, bot.name, { attemptId: attempt.id, ...attempt }, message);
  const connection = await deps.prisma.executionConnection.findFirst({
    where: {
      id: saved?.connectionId ?? configuration?.connectionId,
      spaceId: run.spaceId,
      userId: run.userId,
    },
  });
  if (!connection || connection.revokedAt || (!saved && configuration?.userId !== run.userId)) {
    await fail("The selected execution is unavailable for this account.");
    return true;
  }
  let client = await executionConnectionClient(
    deps.secretStore,
    connection,
    deps.sandbox,
    deps.prisma,
  );
  let request: NativeExecutionStart;
  if (saved) {
    // The encrypted dispatch remains immutable through retries, settings edits, and worker takeover.
    request = executionStartSchema.parse(
      JSON.parse(await deps.secretStore.load(saved.requestRef, run.id)),
    );
  } else {
    const task = await deps.prisma.task.findUniqueOrThrow({ where: { id: run.taskId } });
    const source = run.sourceMessageId
      ? await deps.prisma.message.findUnique({ where: { id: run.sourceMessageId } })
      : null;
    if (
      (source?.blocks as MessageBlock[] | undefined)?.some((block) =>
        ["image", "audio", "file", "video"].includes(block.kind),
      )
    ) {
      await fail("This execution does not accept attachments.");
      return true;
    }
    if (
      run.trigger === BACKGROUND_HELPER_TRIGGER ||
      run.trigger === "messaging" ||
      run.modelPinned
    ) {
      await fail("This entry point requires the built-in execution.");
      return true;
    }
    const scope = {
      spaceId: run.spaceId,
      userId: run.userId,
      botId: run.botId,
      threadId: run.threadId,
      computerId: connection.computerId,
      profileId: configuration!.profileId,
      revision: configuration!.revision,
    };
    if (bot.computerId !== scope.computerId) {
      await fail("Choose an execution on this bot's computer.");
      return true;
    }
    await provisionComputer(deps, scope.computerId, createAdapterContext(run, run.botId, run.id));
    client = await executionConnectionClient(
      deps.secretStore,
      connection,
      deps.sandbox,
      deps.prisma,
    );
    const description = await client.describe().catch(() => null);
    if (
      !description ||
      description.id !== connection.identity ||
      !description.profiles.some(
        (profile) =>
          profile.status === "ready" &&
          profile.id === scope.profileId &&
          profile.revision === scope.revision &&
          profile.spaceId === scope.spaceId &&
          profile.computerId === scope.computerId &&
          profile.userIds.includes(scope.userId),
      )
    ) {
      await fail("The selected execution has not passed its readiness checks.");
      return true;
    }
    const model =
      configuration!.model ??
      description.profiles.find((profile) => profile.id === scope.profileId)!.defaultModel;
    const bindingKey = digest({
      scope,
      identity: connection.identity,
      connectionId: connection.id,
      model,
      instructions: bot.instructions,
    });
    const previous = await deps.prisma.nativeExecution.findFirst({
      where: { bindingKey, completed: true, run: { status: "completed" } },
      orderBy: { createdAt: "desc" },
    });
    const previousRequest = previous
      ? executionStartSchema.parse(
          JSON.parse(await deps.secretStore.load(previous.requestRef, previous.runId)),
        )
      : undefined;
    const previousSource = previous
      ? await deps.prisma.run.findUnique({
          where: { id: previous.runId },
          select: { sourceMessage: { select: { seq: true } } },
        })
      : null;
    const messages = await deps.prisma.message.findMany({
      where: {
        threadId: run.threadId,
        seq: {
          ...(source ? { lt: source.seq } : {}),
          ...(previousSource?.sourceMessage ? { gt: previousSource.sourceMessage.seq } : {}),
        },
      },
      orderBy: { seq: "asc" },
      take: 200,
    });
    request = executionStartSchema.parse({
      runId: run.id,
      scope,
      fence: attempt.fence,
      leaseExpiresAt: leaseExpiry(),
      prompt: task.prompt,
      instructions: bot.instructions,
      context: messages
        .filter((m) => !(m.role === "bot" && m.botId === run.botId && previousRequest))
        .map((m) => ({
          role: m.role === "bot" ? "assistant" : m.role,
          content: (m.blocks as MessageBlock[])
            .filter((b) => b.kind === "text")
            .map((b) => b.text)
            .join("\n"),
        })),
      ...(previous?.sessionId && previous.engineVersion
        ? { session: { id: previous.sessionId, engineVersion: previous.engineVersion } }
        : {}),
      ...(model ? { model } : {}),
    });
    const secret = await deps.secretStore.put(
      JSON.stringify(request),
      createAdapterContext(run, run.botId, run.id),
      { recordId: run.id },
    );
    // A lease check and durable dispatch precede the first remote call.
    saved = await deps.prisma.$transaction(async (tx) => {
      await assertRunCanWriteHistory(tx, run.id, {
        lease: { owner: attempt.workerId, fence: attempt.fence },
      });
      return tx.nativeExecution.create({
        data: {
          runId: run.id,
          spaceId: run.spaceId,
          userId: run.userId,
          connectionId: connection.id,
          requestRef: secret.ref,
          bindingKey,
        },
      });
    });
  }
  let control: NativeExecutionControl | undefined;
  let after = 0;
  let assembled = "";
  let snapshot: NativeExecutionSnapshot;
  let unknownSince: number | undefined;
  const toolResults = new Map<string, string>();
  for (const event of await deps.prisma.event.findMany({
    where: { runId: run.id, type: "effect.recorded" },
  })) {
    const payload = event.payload as Record<string, unknown>;
    if (typeof payload.nativeToolRequestId === "string" && typeof payload.result === "string")
      toolResults.set(payload.nativeToolRequestId, payload.result);
  }
  const deliveredTools = new Set<string>();
  try {
    while (valid() && !deps.shutdownSignal?.aborted) {
      const current = await deps.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
      if (current.leaseFence !== attempt.fence) return true;
      if (current.status === "cancelled") {
        await client.stop({ runId: run.id, scope: request.scope, fence: attempt.fence });
        return true;
      }
      if (current.leaseOwner !== attempt.workerId) return true;
      const authorized = await deps.prisma.executionConnection.findFirst({
        where: { id: connection.id, revokedAt: null, spaceId: run.spaceId, userId: run.userId },
      });
      if (!authorized) {
        await client.stop({ runId: run.id, scope: request.scope, fence: attempt.fence });
        await expireRequests(deps, run.id, attempt);
        await fail("The execution connection was revoked.");
        return true;
      }
      try {
        snapshot = control
          ? await client.attach({ ...control, after, leaseExpiresAt: leaseExpiry() })
          : saved.generation
            ? await client.attach({
                runId: run.id,
                scope: request.scope,
                generation: saved.generation,
                fence: attempt.fence,
                after,
                leaseExpiresAt: leaseExpiry(),
              })
            : await client.start({
                ...request,
                fence: attempt.fence,
                leaseExpiresAt: leaseExpiry(),
              });
        unknownSince = undefined;
      } catch {
        // A lost response is unknown. Repeat only the same durable start or attach, never a new run.
        unknownSince ??= Date.now();
        if (Date.now() - unknownSince > 300_000) {
          await fail(
            "The execution could not be reached. Its result is unknown; the request was not restarted.",
          );
          return true;
        }
        await delay(1000, undefined, { signal: deps.shutdownSignal }).catch(() => undefined);
        continue;
      }
      control = {
        runId: run.id,
        scope: request.scope,
        generation: snapshot.generation,
        fence: attempt.fence,
      };
      if (saved.generation && saved.generation !== control.generation)
        throw new Error("execution_generation_changed");
      if (!saved.generation)
        saved = await deps.prisma.$transaction(async (tx) => {
          await assertRunCanWriteHistory(tx, run.id, {
            lease: { owner: attempt.workerId, fence: attempt.fence },
          });
          return tx.nativeExecution.update({
            where: { runId: run.id },
            data: { generation: control!.generation },
          });
        });
      for (const frame of snapshot.frames) {
        if (frame.sequence !== after + 1) throw new Error("execution_event_gap");
        after = frame.sequence;
        const event = frame.event;
        if (event.type === "text") assembled += event.text;
        if (["completed", "cancelled", "failed"].includes(event.type)) {
          await expireRequests(deps, run.id, attempt);
          const result =
            event.type === "completed"
              ? await deps.events.finalizeRun({
                  spaceId: run.spaceId,
                  threadId: run.threadId,
                  botId: run.botId,
                  runId: run.id,
                  taskId: run.taskId,
                  attemptId: attempt.id,
                  leaseOwner: attempt.workerId,
                  leaseFence: attempt.fence,
                  outcome: "completed",
                  blocks: assembled
                    ? [{ kind: "text", text: redactSecrets(assembled, deps.secrets) }]
                    : [],
                })
              : await fail(
                  event.type === "cancelled"
                    ? "The execution stopped."
                    : "The execution failed. Review its activity before retrying.",
                );
          if (result && typeof result !== "boolean")
            await enqueueSteeringContinuation(deps, result.continuationRunId);
          if (result && event.type === "completed") {
            await deps.prisma.nativeExecution.update({
              where: { runId: run.id },
              data: { completed: true },
            });
            if (run.trigger === "bot_message")
              await returnBotMessageOutcome(deps, run, bot, assembled, "result");
          }
          return true;
        }
        if (frame.sequence <= saved.lastSequence) continue;
        if (event.type === "file") {
          if (!deps.artifacts) throw new Error("artifact_storage_unavailable");
          const currentBot = await deps.prisma.bot.findUniqueOrThrow({ where: { id: run.botId } });
          if (currentBot.disabledBuiltinTools.includes("attach_file"))
            throw new Error("attachment_tool_disabled");
          const group = await deps.prisma.thread.findUniqueOrThrow({
            where: { id: run.threadId },
            select: { groupId: true },
          });
          await attachWorkspaceFileToThread(
            { ...deps, artifacts: deps.artifacts },
            {
              spaceId: run.spaceId,
              userId: run.userId,
              botId: run.botId,
              runId: run.id,
              groupId: group.groupId ?? undefined,
              filePath: event.name,
              bytes: Buffer.from(event.content, "base64"),
              operationId: `native:${run.id}:${frame.sequence}`,
              onAttached: async (tx, artifact) => {
                await assertRunCanWriteHistory(tx, run.id, {
                  lease: { owner: attempt.workerId, fence: attempt.fence },
                });
                await persistMessageInTransaction(
                  tx,
                  run,
                  "bot",
                  [messageBlockForArtifact(artifact)],
                  true,
                  `native:${run.id}:${frame.sequence}`,
                  false,
                  { owner: attempt.workerId, fence: attempt.fence },
                );
                await tx.nativeExecution.update({
                  where: { runId: run.id },
                  data: { lastSequence: frame.sequence },
                });
              },
            },
          );
          const message = await deps.prisma.message.findFirstOrThrow({
            where: { threadId: run.threadId, clientNonce: `native:${run.id}:${frame.sequence}` },
          });
          const latest = await deps.prisma.event.findFirst({
            where: { threadId: run.threadId, runId: run.id },
            orderBy: { seq: "desc" },
          });
          if (latest) await deps.events.notify(message.threadId, latest.seq);
          continue;
        }
        let toolResult: string | undefined;
        if (event.type === "tool_requested") {
          toolResult = JSON.stringify(await executeNativeBridgeTool(deps, run, event));
          if (Buffer.byteLength(toolResult) > 256 * 1024)
            toolResult = JSON.stringify({ error: "Tool result exceeds the execution limit" });
        }
        const seq = await deps.prisma.$transaction(async (tx) => {
          await assertRunCanWriteHistory(tx, run.id, {
            lease: { owner: attempt.workerId, fence: attempt.fence },
          });
          let notification: number | undefined;
          const base = {
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            runId: run.id,
            lease: { owner: attempt.workerId, fence: attempt.fence },
          };
          if (event.type === "tool_requested") {
            notification = (
              await appendEventInTransaction(tx, {
                ...base,
                type: "effect.recorded",
                payload: { nativeToolRequestId: event.id, result: toolResult! },
              })
            ).seq;
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
              `native:${run.id}:${frame.sequence}`,
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
                generation: control!.generation,
                messageId: message.message.id,
              },
            });
            notification = message.eventSeq;
          } else if (event.type === "interaction_closed") {
            const interaction = await tx.nativeInteraction.findUnique({
              where: { runId_requestId: { runId: run.id, requestId: event.id } },
            });
            if (interaction)
              notification = (await updateNativeInteraction(tx, interaction, event.status)).seq;
          } else if (event.type === "session") {
            await tx.nativeExecution.update({
              where: { runId: run.id },
              data: { sessionId: event.session.id, engineVersion: event.session.engineVersion },
            });
          } else {
            const mapped = activity(event);
            if (mapped)
              notification = (await appendEventInTransaction(tx, { ...base, ...mapped })).seq;
          }
          await tx.nativeExecution.update({
            where: { runId: run.id },
            data: { lastSequence: frame.sequence },
          });
          return notification;
        });
        saved.lastSequence = frame.sequence;
        if (event.type === "tool_requested") toolResults.set(event.id, toolResult!);
        if (seq !== undefined) await deps.events.notify(run.threadId, seq);
      }
      for (const [requestId, result] of toolResults) {
        if (!deliveredTools.has(requestId)) {
          await client.toolResult({ ...control, requestId, result }).then(
            () => deliveredTools.add(requestId),
            () => undefined,
          );
        }
      }
      const submitted = await deps.prisma.nativeInteraction.findMany({
        where: { runId: run.id, generation: control.generation, status: "submitted" },
        include: { message: true },
      });
      for (const interaction of submitted) {
        const answer = (interaction.message.blocks as MessageBlock[]).find(
          (b) => b.kind === "ask" && b.nativeRequestId === interaction.requestId,
        );
        if (answer?.kind !== "ask" || !answer.answer) continue;
        // Receipt events drive the card. A failed HTTP response does not mark it approved.
        await client
          .respond({ ...control, requestId: interaction.requestId, answer: answer.answer })
          .catch(() => undefined);
      }
      if (snapshot.frames.length < 128)
        await delay(500, undefined, { signal: deps.shutdownSignal }).catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof RunHistoryWriteError || !valid() || deps.shutdownSignal?.aborted)
      return true;
    // No fresh dispatch after an event/protocol failure. Stop first, then report the failure.
    await client.stop({ runId: run.id, scope: request.scope, fence: attempt.fence });
    await expireRequests(deps, run.id, attempt);
    await fail("The execution could not continue safely.");
  }
  return true;
}

function activity(event: NativeExecutionEvent) {
  if (event.type === "text")
    return { type: "thread.progress" as const, payload: { delta: event.text, streaming: true } };
  if (event.type === "operation")
    return {
      type: "thread.progress" as const,
      payload: { text: event.detail || event.name, activity: true },
    };
  if (event.type === "usage")
    return {
      type: "usage.recorded" as const,
      payload: {
        scope: event.scope ?? "run",
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        costUsd: event.costUsd,
      },
    };
  return undefined;
}

async function expireRequests(
  deps: ExecutorDeps,
  runId: string,
  attempt: { workerId: string; fence: number },
) {
  const pending = await deps.prisma.nativeInteraction.findMany({
    where: { runId, status: { in: ["pending", "submitted"] } },
  });
  for (const interaction of pending) {
    const event = await deps.prisma.$transaction(async (tx) => {
      await assertRunCanWriteHistory(tx, runId, {
        lease: { owner: attempt.workerId, fence: attempt.fence },
      });
      const current = await tx.nativeInteraction.findUniqueOrThrow({
        where: { id: interaction.id },
      });
      if (!["pending", "submitted"].includes(current.status)) return null;
      return updateNativeInteraction(tx, current, "expired");
    });
    if (!event) continue;
    const message = await deps.prisma.message.findUniqueOrThrow({
      where: { id: interaction.messageId },
    });
    await deps.events.notify(message.threadId, event.seq);
  }
}
