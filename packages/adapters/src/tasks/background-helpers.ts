import type { MessageBlock } from "@rakazo/contracts";
import { canonicalPiProviderId } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  BACKGROUND_HELPER_TRIGGER,
  HELPER_RESULT_TRIGGER,
  isApprovalAskBlock,
  isConversationalRun,
  STOPPED_HELPER_RESULT,
} from "@rakazo/core";
import {
  appendEventInTransaction,
  assertRunCanWriteHistory,
  changeMessageBlocks,
  createThreadMessageInTransaction,
  storedMessageBlocks,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { resolveModelChoice } from "../models/model-choice.js";
import {
  PINNED_PROVIDER_NOT_CONNECTED,
  validateBotModelChange,
} from "../models/model-selection.js";
import type { RunContext } from "../runs/assembly/run-context.js";
import { runLeaseFor } from "../runs/assembly/run-messages.js";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";
import { fleetPrepareDeps } from "../runs/turn/run-model.js";
import { wakeRun } from "../runs/wakeups/wake-run.js";
import { listPiCatalog } from "../runtime/pi/models/pi-models.js";
import {
  helperResultText,
  MAX_PARALLEL_SUBAGENTS,
} from "../runtime/pi/tools/pi-runtime-subagent.js";
import {
  backgroundHelperLimitNote,
  helperPrompt,
  resultPrompt,
  SUBAGENT_DELEGATION_UNAVAILABLE,
  startedNote,
} from "./background-helpers.prompt.js";

const RESULT_LIMIT = 12_000;

// Stop only settles a card, so it brings no job queue.
type HelperDeps = Pick<ExecutorDeps, "prisma"> & {
  events: Pick<ExecutorDeps["events"], "notify">;
  jobs?: ExecutorDeps["jobs"];
};
type HelperBlock = Extract<MessageBlock, { kind: "subagent" }>;

/** Delegation has one behavior in every conversation, without recursive result chains. */
export function backgroundHelpersAllowed(turn: { trigger: string }): boolean {
  return turn.trigger !== HELPER_RESULT_TRIGGER && isConversationalRun(turn.trigger);
}

/** A catalog provider id, including the stored Azure alias. Display labels are not ids. */
function isCatalogProviderId(provider: string): boolean {
  const canonical = canonicalPiProviderId(provider);
  return listPiCatalog().some((entry) => entry.provider === canonical);
}

/**
 * Resolve a caller-supplied pair before a helper exists. The model id is the query, and a
 * `provider/id` string matches the catalog. The provider filter is only a catalog id: a display
 * label would match no connection and then be returned unchanged.
 */
async function resolveHelperModelPin(
  ctx: RunContext,
  modelProvider: string,
  modelId: string,
): Promise<{ provider: string; model: string } | { error: string }> {
  const prepared = await fleetPrepareDeps(ctx.deps, {
    userId: ctx.run.userId,
    spaceId: ctx.run.spaceId,
  });
  const deps = { prisma: prepared.prisma, ...prepared.modelChange };
  const scope = { userId: ctx.run.userId, spaceId: ctx.run.spaceId };
  const chosen = await resolveModelChoice(deps, scope, {
    model: modelId,
    ...(isCatalogProviderId(modelProvider) ? { provider: modelProvider } : {}),
  });
  if (!chosen.ok) return { error: chosen.error };
  const validated = await validateBotModelChange(deps, {
    ...scope,
    provider: chosen.provider,
    model: chosen.model,
  });
  if (!validated.ok) return { error: validated.error };
  if (!validated.provider || !validated.model) return { error: PINNED_PROVIDER_NOT_CONNECTED };
  return { provider: validated.provider, model: validated.model };
}

export async function startBackgroundHelper(
  ctx: RunContext,
  input: {
    name: string;
    task: string;
    instructions: string;
    modelProvider: string;
    modelId: string;
    executionId: string;
    effectKey: string;
  },
) {
  const { deps, run, runId, bot, thread } = ctx;
  if (!backgroundHelpersAllowed(run)) {
    return {
      error: SUBAGENT_DELEGATION_UNAVAILABLE,
    };
  }
  if (Boolean(input.modelProvider) !== Boolean(input.modelId)) {
    return { error: "model_provider and model_id must both be set" };
  }
  // An inherited parent pin is already stored and is not checked again.
  let modelProvider = input.modelProvider || (run.modelPinned ? run.modelProvider : "");
  let modelId = input.modelId || (run.modelPinned ? run.modelId : "");
  if (input.modelProvider && input.modelId) {
    const resolved = await resolveHelperModelPin(ctx, input.modelProvider, input.modelId);
    if ("error" in resolved) return resolved;
    modelProvider = resolved.provider;
    modelId = resolved.model;
  }
  const clientNonce = `background-helper:${input.effectKey}`;
  const started = { ok: true as const, name: input.name, note: startedNote(input.name) };
  const card: HelperBlock = {
    kind: "subagent",
    agentId: input.executionId,
    name: input.name,
    task: input.task,
    status: "running",
  };
  const committed = await deps.prisma.$transaction(async (tx) => {
    // Every start goes through this chat, so its lock makes the replay check and the cap exact
    // even when one turn starts several helpers at once.
    if (thread.groupId)
      await tx.$queryRaw`SELECT id FROM chat_groups WHERE id = ${thread.groupId} FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
    // The cap belongs to the bot, including starts in different conversations.
    await tx.$queryRaw`SELECT id FROM bots WHERE id = ${bot.id} FOR UPDATE`;
    if (
      await tx.run.findFirst({ where: { spaceId: run.spaceId, clientNonce }, select: { id: true } })
    )
      return null;
    const running = await tx.run.count({
      where: {
        botId: bot.id,
        trigger: BACKGROUND_HELPER_TRIGGER,
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
    });
    if (running >= MAX_PARALLEL_SUBAGENTS) return "full" as const;
    // Only this turn's live worker may start one, but the card is not part of the turn: a turn
    // ending settles its own helper cards as stopped, while this helper keeps working.
    await assertRunCanWriteHistory(tx, runId, { lease: runLeaseFor(deps, runId) });
    const message = await createThreadMessageInTransaction(tx, {
      threadId: thread.id,
      role: "bot",
      blocks: [card],
      botId: bot.id,
      markUnread: false,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: thread.id,
      botId: bot.id,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks: [card] },
    });
    // The helper's own thread: no chat list shows it, nothing sent to the bot waits behind the
    // helper, and it goes when the bot is deleted.
    const helperThread = await tx.thread.create({
      data: { spaceId: run.spaceId, userId: run.userId, helperBotId: bot.id },
      select: { id: true },
    });
    const task = await tx.task.create({
      data: {
        spaceId: run.spaceId,
        botId: bot.id,
        threadId: helperThread.id,
        userId: run.userId,
        prompt: helperPrompt(input),
        status: "queued",
      },
    });
    const helperRun = await tx.run.create({
      data: {
        spaceId: run.spaceId,
        botId: bot.id,
        threadId: helperThread.id,
        taskId: task.id,
        userId: run.userId,
        status: "queued",
        trigger: BACKGROUND_HELPER_TRIGGER,
        sourceMessageId: message.id,
        delegatedFromRunId: runId,
        clientNonce,
        ...(modelProvider && modelId ? { modelProvider, modelId, modelPinned: true } : {}),
      },
      select: { id: true },
    });
    // The originating user's files remain available even when the parent never booted
    // its computer. Keep the input on the helper's own history for restart and approval resume.
    const sources = await tx.message.findMany({
      where: {
        threadId: thread.id,
        role: "user",
        OR: [
          { id: run.sourceMessageId ?? "" },
          { steeringMessages: { some: { runId, claimedAt: { not: null } } } },
        ],
      },
      select: { id: true, blocks: true },
      orderBy: { seq: "asc" },
    });
    const attachments = sources.flatMap((source) =>
      storedMessageBlocks(source).filter(
        (block) => block.kind === "file" || block.kind === "image",
      ),
    );
    if (attachments.length) {
      const input = await createThreadMessageInTransaction(tx, {
        threadId: helperThread.id,
        role: "user",
        authorUserId: run.userId,
        botId: bot.id,
        runId: helperRun.id,
        blocks: attachments,
        markUnread: false,
      });
      await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: helperThread.id,
        botId: bot.id,
        runId: helperRun.id,
        type: "thread.message.created",
        payload: { messageId: input.id, role: "user", blocks: attachments },
      });
    }
    return { eventSeq: event.seq, helperRunId: helperRun.id };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (committed === "full") {
    return {
      error: backgroundHelperLimitNote(MAX_PARALLEL_SUBAGENTS),
    };
  }
  if (!committed) return started;
  await deps.events.notify(thread.id, committed.eventSeq).catch((error) => {
    getLogger().error("background helper card notification", error);
  });
  await wakeRun(deps.jobs, committed.helperRunId);
  return started;
}

/**
 * Settle a finished helper's card and bring its result back to the chat that started it as a
 * new turn. Each helper returns once; a helper the user stopped only settles its card.
 */
export async function returnHelperOutcome(
  deps: HelperDeps,
  run: {
    id: string;
    spaceId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
  },
  outcome: { status: "completed" | "failed" | "stopped"; text: string },
) {
  // The card's chat, read first so the lock below can come before any other row.
  const source = run.sourceMessageId
    ? await deps.prisma.message.findUnique({
        where: { id: run.sourceMessageId },
        select: { threadId: true },
      })
    : null;
  const committed = await deps.prisma.$transaction(async (tx) => {
    // Same lock order as clearing chat (and the cloud-agent wake): thread first.
    if (source) await tx.$queryRaw`SELECT id FROM threads WHERE id = ${source.threadId} FOR UPDATE`;
    const claimed = await tx.run.updateMany({
      where: {
        id: run.id,
        trigger: BACKGROUND_HELPER_TRIGGER,
        status: { in: ["completed", "failed", "cancelled"] },
        botOutcomeReturnedAt: null,
      },
      data: { botOutcomeReturnedAt: new Date() },
    });
    if (claimed.count !== 1 || !source || !run.sourceMessageId) return null;
    const card = await tx.message.findFirst({
      where: { id: run.sourceMessageId, threadId: source.threadId },
      select: {
        id: true,
        threadId: true,
        blocks: true,
        thread: {
          select: {
            group: {
              select: {
                archivedAt: true,
                members: { where: { botId: run.botId }, select: { botId: true } },
              },
            },
          },
        },
      },
    });
    const blocks = card ? storedMessageBlocks(card) : [];
    const helper = blocks.find((block): block is HelperBlock => block.kind === "subagent");
    // The chat was cleared since: nothing is left to settle or answer.
    if (!card || !helper) return null;
    if (outcome.status !== "completed") {
      const requests = await tx.message.findMany({
        where: { threadId: card.threadId, runId: run.id, role: "bot" },
        select: { id: true, blocks: true },
      });
      for (const request of requests) {
        const denied = changeMessageBlocks(request, (block) =>
          block.kind === "ask" && isApprovalAskBlock(block) && block.status !== "answered"
            ? { ...block, status: "answered" as const, answer: "deny" }
            : block,
        );
        if (!denied) continue;
        await tx.message.update({
          where: { id: request.id },
          data: { blocks: denied.stored },
        });
        await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: card.threadId,
          botId: run.botId,
          type: "thread.message.updated",
          runId: run.id,
          allowCancelledRun: true,
          payload: { messageId: request.id, role: "bot", blocks: denied.blocks },
        });
      }
    }
    const result =
      outcome.status === "stopped"
        ? STOPPED_HELPER_RESULT
        : helperResultText(outcome.text.trim() || "done.", undefined, RESULT_LIMIT);
    const settled: HelperBlock = {
      ...helper,
      status: outcome.status === "completed" ? "completed" : "failed",
      progress: undefined,
      result,
    };
    const next = changeMessageBlocks(card, (block) => (block === helper ? settled : block));
    if (!next) return null;
    const nextBlocks = next.blocks;
    await tx.message.update({ where: { id: card.id }, data: { blocks: next.stored } });
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: card.threadId,
      botId: run.botId,
      type: "thread.message.updated",
      payload: { messageId: card.id, role: "bot", blocks: nextBlocks },
    });
    if (
      outcome.status === "stopped" ||
      (card.thread?.group && (card.thread.group.archivedAt || !card.thread.group.members.length))
    )
      return { threadId: card.threadId, eventSeq: event.seq };
    // Like the cloud-agent wake: only for a person still in the space and a bot still active
    // there. In a shared space that bot may be another member's; the turn runs as this person.
    const [member, bot] = await Promise.all([
      tx.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: run.spaceId, userId: run.userId } },
        select: { id: true },
      }),
      tx.bot.findFirst({
        where: { id: run.botId, spaceId: run.spaceId, archivedAt: null },
        select: { id: true },
      }),
    ]);
    if (!member || !bot) return { threadId: card.threadId, eventSeq: event.seq };
    const task = await tx.task.create({
      data: {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: card.threadId,
        userId: run.userId,
        prompt: resultPrompt(helper.name, outcome.status, result),
        status: "queued",
      },
    });
    const wake = await tx.run.create({
      data: {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: card.threadId,
        taskId: task.id,
        userId: run.userId,
        status: "queued",
        trigger: HELPER_RESULT_TRIGGER,
        delegatedFromRunId: run.id,
        clientNonce: `helper-result:${run.id}`,
      },
      select: { id: true },
    });
    const replies = await tx.message.findMany({
      where: { runId: run.id, role: "bot" },
      orderBy: { seq: "asc" },
      select: { id: true, blocks: true },
    });
    const attachments = replies.flatMap((reply) =>
      storedMessageBlocks(reply).filter((block) => block.kind === "file" || block.kind === "image"),
    );
    let eventSeq = event.seq;
    if (attachments.length) {
      const attached = await createThreadMessageInTransaction(tx, {
        threadId: card.threadId,
        botId: run.botId,
        role: "bot",
        runId: wake.id,
        blocks: attachments,
      });
      eventSeq = (
        await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: card.threadId,
          botId: run.botId,
          runId: wake.id,
          type: "thread.message.created",
          payload: { messageId: attached.id, role: "bot", blocks: attachments },
        })
      ).seq;
    }
    return { threadId: card.threadId, eventSeq, wakeRunId: wake.id };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (!committed) return;
  await deps.events.notify(committed.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("background helper card notification", error);
  });
  if (committed.wakeRunId && deps.jobs) await wakeRun(deps.jobs, committed.wakeRunId);
}
