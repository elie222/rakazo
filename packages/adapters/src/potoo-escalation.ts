import type { JobPublisher } from "@rakazo/adapter-kit";
import { potooEscalateJob, runContinueJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  buildEscalationTaskPrompt,
  escalationClientNonce,
  extractPatrolJson,
  extractReportText,
  formatToolTranscript,
  shouldEscalate,
} from "@rakazo/potoo";

const ESCALATION_TOOL_TYPES = ["agent.tool.called", "agent.tool.completed", "thread.subagent"];
const MAX_TRANSCRIPT_EVENTS = 500;

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

/** Gate a finished patrol flight: bloody copy enqueues verification, everything else stops here. Never throws. */
export async function maybeEscalatePatrolRun(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  runId: string,
  finalText: string,
): Promise<void> {
  try {
    if (!shouldEscalate(finalText)) return;
    await deps.jobs.enqueue(potooEscalateJob(runId));
  } catch (error) {
    getLogger().error("potoo escalate enqueue failed", error);
  }
}

/**
 * File the escalation: load the patrol's report plus its redacted tool
 * transcript from the database, then open an escalation run in the same
 * thread. Idempotent per patrol run via the run clientNonce unique key.
 */
export async function escalatePatrolRun(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  patrolRunId: string,
): Promise<void> {
  const patrol = await deps.prisma.run.findUnique({ where: { id: patrolRunId } });
  if (patrol?.status !== "completed") return;
  const nonce = escalationClientNonce(patrolRunId);
  const existing = await deps.prisma.run.findUnique({
    where: { spaceId_clientNonce: { spaceId: patrol.spaceId, clientNonce: nonce } },
  });
  if (existing) return;
  const messages = await deps.prisma.message.findMany({
    where: { threadId: patrol.threadId, runId: patrolRunId },
    orderBy: { seq: "desc" },
    take: 5,
  });
  const messageText = messages
    .map((message) => extractReportText(message.blocks))
    .find((text): text is string => text !== null);
  if (!messageText) return;
  const patrolJson = extractPatrolJson(messageText);
  if (!patrolJson || !shouldEscalate(messageText)) return;
  const toolEvents = await deps.prisma.event.findMany({
    where: {
      threadId: patrol.threadId,
      runId: patrolRunId,
      type: { in: ESCALATION_TOOL_TYPES },
    },
    orderBy: { seq: "asc" },
    take: MAX_TRANSCRIPT_EVENTS + 1,
    select: { type: true, payload: true },
  });
  const truncated = toolEvents.length > MAX_TRANSCRIPT_EVENTS;
  const transcript =
    formatToolTranscript(toolEvents.slice(0, MAX_TRANSCRIPT_EVENTS)) +
    (truncated ? `\n(truncated: showing first ${MAX_TRANSCRIPT_EVENTS} tool events)` : "");
  const prompt = buildEscalationTaskPrompt(patrolJson, transcript);
  let created: { runId: string; taskId: string } | null = null;
  try {
    created = await deps.prisma.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          spaceId: patrol.spaceId,
          botId: patrol.botId,
          threadId: patrol.threadId,
          userId: patrol.userId,
          prompt,
          status: "queued",
        },
      });
      const run = await tx.run.create({
        data: {
          spaceId: patrol.spaceId,
          botId: patrol.botId,
          threadId: patrol.threadId,
          taskId: task.id,
          userId: patrol.userId,
          status: "queued",
          trigger: "routine",
          clientNonce: nonce,
        },
      });
      return { runId: run.id, taskId: task.id };
    });
  } catch (error) {
    // A concurrent handler already filed this escalation.
    if (isUniqueViolation(error)) return;
    throw error;
  }
  try {
    await deps.jobs.enqueue(runContinueJob(created.runId));
  } catch (error) {
    // Restore the claim so a retry can file again instead of stranding a queued run.
    await deps.prisma.$transaction(async (tx) => {
      await tx.run.deleteMany({ where: { id: created.runId, status: "queued" } });
      await tx.task.deleteMany({ where: { id: created.taskId, status: "queued" } });
    });
    throw error;
  }
}
