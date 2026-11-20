import type { JobPublisher, JobTransaction } from "@rakazo/adapter-kit";
import { approvalExpireJob } from "@rakazo/adapter-kit";
import { approvalCardExpires, unattendedApprovalExpireAfterMs } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { storedMessageBlocks } from "@rakazo/db";
import { wakeRun } from "../runs/wakeups/wake-run.js";

/**
 * Schedules the end of an approval card an unattended run posts, in the transaction that pauses
 * the run for it. A run someone is watching keeps its card open until answered.
 */
export async function scheduleApprovalExpiry(
  jobs: JobPublisher,
  tx: JobTransaction,
  card: { trigger: string; runId: string; effectId: string },
  now = Date.now(),
): Promise<void> {
  if (!approvalCardExpires(card.trigger)) return;
  await jobs.enqueueIn(
    tx,
    approvalExpireJob(card.runId, card.effectId, new Date(now + unattendedApprovalExpireAfterMs())),
  );
}

/**
 * Ends an approval card an unattended run posted (see approvalCardExpires) if it is still
 * unanswered: the action is not done, and the run resumes told nobody answered in time.
 */
export async function expireApprovalCard(
  deps: { prisma: PrismaClient; events: ThreadEvents; jobs: JobPublisher },
  input: { runId: string; effectId: string },
): Promise<void> {
  const run = await deps.prisma.run.findUnique({
    where: { id: input.runId },
    select: { status: true, spaceId: true, userId: true },
  });
  if (run?.status !== "waiting_input") return;
  const messages = await deps.prisma.message.findMany({
    where: { runId: input.runId, role: "bot" },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { id: true, threadId: true, blocks: true },
  });
  const card = messages.find((message) =>
    storedMessageBlocks(message).some(
      (block) =>
        block.kind === "ask" &&
        block.approvalEffectId === input.effectId &&
        block.status !== "answered",
    ),
  );
  if (!card) return;
  const answered = await deps.events.answerRunInput({
    spaceId: run.spaceId,
    threadId: card.threadId,
    runId: input.runId,
    messageId: card.id,
    answeredByUserId: run.userId,
    answer: "deny",
    expired: true,
  });
  if (answered) await wakeRun(deps.jobs, input.runId);
}
