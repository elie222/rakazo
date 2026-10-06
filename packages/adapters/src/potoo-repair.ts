import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { DetectedPotooFlight } from "@rakazo/potoo";
import {
  buildRepairTaskPrompt,
  ESCALATION_TEMPERATURE,
  isPotooRepair,
  parseReport,
  repairClientNonce,
} from "@rakazo/potoo";

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

/**
 * Live copy repair (P4): when a patrol or escalation flight finishes
 * without a parseable filing, file one repair run with the same system
 * and temperature plus the original reply for context. Single attempt —
 * the repair run's own completion never repairs again. Never throws;
 * every outcome is logged, never silent.
 */
export async function maybeRepairCopy(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  run: { id: string; spaceId: string; botId: string; threadId: string; userId: string },
  flight: DetectedPotooFlight,
  finalText: string,
): Promise<void> {
  try {
    if (parseReport(finalText)) return;
    const kind = flight.temperature === ESCALATION_TEMPERATURE ? "escalation" : "patrol";
    const nonce = repairClientNonce(run.id);
    const existing = await deps.prisma.run.findUnique({
      where: { spaceId_clientNonce: { spaceId: run.spaceId, clientNonce: nonce } },
    });
    if (existing) return;
    const prompt = buildRepairTaskPrompt(kind, finalText);
    // Sanity: the repair prompt must re-enter as the same flight.
    if (!isPotooRepair(prompt)) {
      getLogger().error("potoo repair prompt lost its marker", { runId: run.id });
      return;
    }
    let created: { runId: string; taskId: string } | null = null;
    try {
      created = await deps.prisma.$transaction(async (tx) => {
        const task = await tx.task.create({
          data: {
            spaceId: run.spaceId,
            botId: run.botId,
            threadId: run.threadId,
            userId: run.userId,
            prompt,
            status: "queued",
          },
        });
        const repair = await tx.run.create({
          data: {
            spaceId: run.spaceId,
            botId: run.botId,
            threadId: run.threadId,
            taskId: task.id,
            userId: run.userId,
            status: "queued",
            trigger: "routine",
            clientNonce: nonce,
          },
        });
        return { runId: repair.id, taskId: task.id };
      });
    } catch (error) {
      if (isUniqueViolation(error)) return;
      throw error;
    }
    await deps.jobs.enqueue(runContinueJob(created.runId));
  } catch (error) {
    getLogger().error("potoo copy repair failed", { runId: run.id, error });
  }
}
