/**
 * Local, opt-in coordinator for a group handoff chain.
 *
 * Durable, local-only goal checkpoints for a multi-bot group. Each completed
 * stage gets assessed by the goal owner; that owner can request another distinct
 * specialist stage, or finalize. Stops at budget/supersession and never replays
 * old work. No internal planner text is added as a visible chat message.
 */
import { type JobPublisher, runContinueJob } from "@rakazo/adapter-kit";
import { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

// At most three autonomous assessment rounds per user request. A round can
// decide to finish or delegate further. No timer-driven background goal creation.
export const LOCAL_AUTONOMY_MAX_ROUNDS = 3;
export const LOCAL_AUTONOMY_MAX_AGE_MS = 20 * 60_000;
export const LOCAL_AUTONOMY_RUN_NONCE_PREFIX = "local-agent-goal:";

function reviewTaskPrompt(round: number): string {
  return [
    `[Internal goal assessment, round ${round}/${LOCAL_AUTONOMY_MAX_ROUNDS}]`,
    "You are the owner of the original user's request in this shared group.",
    "The user gave the goal, not a detailed workflow. Own its execution and quality.",
    "Review the original human request and all work already done by this group.",
    "Identify important unknowns or unsupported assumptions; distinguish substantive gaps from trivia.",
    "Compare distinct teammates' evidence, resolve genuine disagreements and choose the relevant specialist for any material follow-up instead of broadcasting to everyone.",
    "Check any claim that data is unavailable against the user's earlier supplied facts in this shared thread. Correct contradictory calculations before finalizing.",
    "Decide yourself whether to stop, research further using existing tools, or delegate a DISTINCT next stage to a specialist using handoff_to_bot.",
    "If a further specialist stage is warranted, actually call the handoff tool with the missing evidence to check. The worker will resume you after it finishes.",
    "If the goal is already satisfied, DO NOT invent work or handoffs; close with a short, useful final answer, avoiding verbatim repetition.",
    "If a meaningful answer requires unavailable facts, report limits or ask the user rather than pretending verification occurred.",
    round >= LOCAL_AUTONOMY_MAX_ROUNDS
      ? "Final budget round: do not delegate; synthesize the evidence and unresolved gaps now."
      : "Stay within the existing request and only investigate further when it materially improves the result.",
    "Never send email, place trades, delete or change external data without the ordinary explicit approval.",
    "You cannot extend your own round budget. Do not continue merely to keep agents talking.",
  ].join("\n");
}

const AUTONOMY_NONCE = /^local-agent-goal:([a-z0-9]+):(\d+)$/;

export function localGroupReviewConfig(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  since: Date | null;
} {
  // Requiring an explicit timestamp also guarantees old group runs never reawaken
  // after an upgrade/restart or a feature toggle.
  const sinceValue = env.RAKAZO_GROUP_REVIEW_SINCE;
  const since = sinceValue ? new Date(sinceValue) : null;
  return {
    enabled:
      env.RAKAZO_GROUP_REVIEW_ENABLED === "true" &&
      since !== null &&
      Number.isFinite(since.getTime()),
    since: since && Number.isFinite(since.getTime()) ? since : null,
  };
}

function containsHandoff(blocks: unknown): boolean {
  const parsed = MessageBlock.array().safeParse(blocks);
  return parsed.success && parsed.data.some((block) => block.kind === "handoff");
}

/** Reconstructs the persistent goal state from the original human run and
 * synthetic goal-checkpoint runs. Handoff chains may be arbitrarily nested. */
async function resolveGoalOrigin(
  tx: Pick<PrismaClient, "run">,
  terminalRunId: string,
  threadId: string,
  spaceId: string,
  userId: string,
): Promise<{
  rootId: string;
  botId: string;
  round: number;
  createdAt: Date;
  sourceMessageId: string;
}> {
  const visited = new Set<string>();
  let cursor: string | null = terminalRunId;
  for (let depth = 0; depth < 24 && cursor; depth++) {
    if (visited.has(cursor)) break;
    visited.add(cursor);
    const currentRun: {
      id: string;
      botId: string;
      userId: string;
      spaceId: string;
      threadId: string;
      trigger: string;
      clientNonce: string | null;
      createdAt: Date;
      sourceMessageId: string | null;
      sourceMessage: { role: string; runId: string | null; blocks: unknown } | null;
    } | null = await tx.run.findUnique({
      where: { id: cursor },
      select: {
        id: true,
        botId: true,
        userId: true,
        spaceId: true,
        threadId: true,
        trigger: true,
        clientNonce: true,
        createdAt: true,
        sourceMessageId: true,
        sourceMessage: { select: { role: true, runId: true, blocks: true } },
      },
    });
    if (
      !currentRun ||
      currentRun.threadId !== threadId ||
      currentRun.spaceId !== spaceId ||
      currentRun.userId !== userId
    )
      break;

    const parsed = currentRun.clientNonce?.match(AUTONOMY_NONCE);
    if (parsed) {
      const root = await tx.run.findUnique({
        where: { id: parsed[1]! },
        select: {
          id: true,
          botId: true,
          userId: true,
          spaceId: true,
          threadId: true,
          createdAt: true,
          sourceMessageId: true,
          sourceMessage: { select: { role: true } },
        },
      });
      if (
        root &&
        root.threadId === threadId &&
        root.spaceId === spaceId &&
        root.userId === userId &&
        root.sourceMessage?.role === "user" &&
        root.sourceMessageId
      ) {
        return {
          rootId: root.id,
          botId: root.botId,
          round: Number(parsed[2]),
          createdAt: root.createdAt,
          sourceMessageId: root.sourceMessageId,
        };
      }
      break;
    }
    // Reject synthetic markers from earlier single-wake implementations.
    if (
      currentRun.sourceMessage?.role === "bot" &&
      !containsHandoff(currentRun.sourceMessage.blocks)
    )
      break;
    if (
      currentRun.sourceMessage?.role === "user" &&
      (currentRun.trigger === "user" || currentRun.trigger === "follow_up") &&
      currentRun.sourceMessageId
    ) {
      return {
        rootId: currentRun.id,
        botId: currentRun.botId,
        round: 0,
        createdAt: currentRun.createdAt,
        sourceMessageId: currentRun.sourceMessageId,
      };
    }
    if (!currentRun.sourceMessage || !containsHandoff(currentRun.sourceMessage.blocks)) break;
    cursor = currentRun.sourceMessage.runId;
  }
  throw new Error("Local orchestration cannot resolve a valid original user request");
}

/** Perform one atomic, idempotent transition in the local goal state machine.
 * On completion of an original user task or a delegated subtask, schedule one
 * assessment run. If an assessment delegates, wait for its child to complete;
 * if it doesn't delegate, that is the completion gate. */
export async function scheduleLocalGroupReview(
  deps: { prisma: PrismaClient; jobs: JobPublisher; events: ThreadEvents },
  completedRunId: string,
): Promise<{ scheduled: boolean; runId?: string }> {
  const result = await deps.prisma.$transaction(async (tx) => {
    // A run-level lock serializes recovery/reconciler races. The marker is
    // committed with the follow-up run; no duplicate run after a crash.
    await tx.$queryRaw`SELECT id FROM runs WHERE id = ${completedRunId} FOR UPDATE`;
    const finished = await tx.run.findUnique({
      where: { id: completedRunId },
      select: {
        id: true,
        botId: true,
        userId: true,
        spaceId: true,
        threadId: true,
        status: true,
        trigger: true,
        groupReviewScheduledAt: true,
        sourceMessageId: true,
        thread: { select: { groupId: true } },
      },
    });
    if (
      !finished ||
      finished.status !== "completed" ||
      !["user", "follow_up"].includes(finished.trigger) ||
      finished.groupReviewScheduledAt ||
      !finished.thread.groupId ||
      !finished.sourceMessageId
    )
      return { scheduled: false };

    const markChecked = async () => {
      await tx.run.update({
        where: { id: finished.id },
        data: { groupReviewScheduledAt: new Date() },
      });
      return { scheduled: false };
    };
    let origin: Awaited<ReturnType<typeof resolveGoalOrigin>>;
    try {
      origin = await resolveGoalOrigin(
        tx,
        finished.id,
        finished.threadId,
        finished.spaceId,
        finished.userId,
      );
    } catch {
      return markChecked();
    }
    const { rootId, botId, round, createdAt, sourceMessageId } = origin;
    if (!Number.isInteger(round) || round < 0 || round > LOCAL_AUTONOMY_MAX_ROUNDS) {
      return markChecked();
    }
    if (Date.now() - createdAt.getTime() > LOCAL_AUTONOMY_MAX_AGE_MS) {
      return markChecked();
    }

    // A human's later instruction supersedes the old goal. No competing
    // autonomous pipeline should overwrite a newer group conversation.
    const newerHumanMessage = await tx.message.findFirst({
      where: {
        threadId: finished.threadId,
        role: "user",
        createdAt: { gt: createdAt },
        id: { not: sourceMessageId },
      },
      select: { id: true },
    });
    if (newerHumanMessage) return markChecked();

    const delegatedAgain = await tx.event.findFirst({
      where: { runId: finished.id, type: "group.handoff" },
      select: { id: true },
    });
    if (delegatedAgain) return markChecked();
    // The goal is complete if its assessment finished without new delegation.
    // Never schedule assessments of an already assessed answer forever.
    const nonce = `${LOCAL_AUTONOMY_RUN_NONCE_PREFIX}${rootId}:${round + 1}`;
    if (
      round >= LOCAL_AUTONOMY_MAX_ROUNDS ||
      (finished.id !== rootId && finished.botId === botId && round > 0)
    ) {
      return markChecked();
    }
    const group = await tx.chatGroup.findFirst({
      where: {
        id: finished.thread.groupId,
        spaceId: finished.spaceId,
        userId: finished.userId,
        archivedAt: null,
        members: { some: { botId, bot: { archivedAt: null } } },
      },
      select: { id: true, members: { take: 2, select: { botId: true } } },
    });
    // Deliberately only multi-bot groups; direct/trivial one-bot use unchanged.
    if (!group || group.members.length < 2) return markChecked();
    const existing = await tx.run.findFirst({
      where: { spaceId: finished.spaceId, clientNonce: nonce },
      select: { id: true },
    });
    if (existing) {
      await markChecked();
      return { scheduled: false, runId: existing.id };
    }
    const prompt = reviewTaskPrompt(round + 1);
    const task = await tx.task.create({
      data: {
        spaceId: finished.spaceId,
        threadId: finished.threadId,
        botId,
        userId: finished.userId,
        prompt,
        status: "queued",
      },
      select: { id: true },
    });
    const nextRun = await tx.run.create({
      data: {
        spaceId: finished.spaceId,
        threadId: finished.threadId,
        botId,
        userId: finished.userId,
        taskId: task.id,
        status: "queued",
        trigger: "follow_up",
        clientNonce: nonce,
        // Link to the real user message. No fake user request or visible bot
        // message containing internal planning instructions is created.
        sourceMessageId,
      },
      select: { id: true },
    });
    await tx.run.update({
      where: { id: finished.id },
      data: { groupReviewScheduledAt: new Date() },
    });
    return { scheduled: true, runId: nextRun.id };
  });
  if (result.scheduled && result.runId) {
    await deps.jobs.enqueue(runContinueJob(result.runId)).catch((error) =>
      // The run is durable; upstream reconciliation reschedules queued runs.
      getLogger().error("local goal assessment enqueue", error),
    );
  }
  return { scheduled: result.scheduled, ...(result.runId ? { runId: result.runId } : {}) };
}
