import type { ToolCallOutcome, ToolCallRecord } from "@rakazo/contracts";
import { TOOL_CALL_RECORD_RETENTION_MS, TOOL_CALL_RECORDS_MAX } from "@rakazo/contracts";
import type { PrismaClient } from "../database/client.js";

/** One call's trace, already redacted with the run's secrets and capped before it gets here. */
export interface ToolCallRecordInput {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  executionId: string;
  tool: string;
  durationMs: number;
  outcome: ToolCallOutcome;
  arguments?: string;
  error?: string;
  resultBytes?: number;
  resultShortened?: boolean;
  resultHead?: string;
}

/**
 * Keeps one call's trace. Never throws for the caller: a run's own work must not fail because its
 * explanation could not be stored.
 */
export async function createToolCallRecord(
  prisma: Pick<PrismaClient, "toolCallRecord">,
  record: ToolCallRecordInput,
): Promise<void> {
  await prisma.toolCallRecord.create({
    data: {
      spaceId: record.spaceId,
      threadId: record.threadId,
      botId: record.botId,
      runId: record.runId,
      executionId: record.executionId,
      tool: record.tool,
      durationMs: Math.max(0, Math.round(record.durationMs)),
      outcome: record.outcome,
      arguments: record.arguments,
      error: record.error,
      resultBytes: record.resultBytes,
      resultShortened: record.resultShortened ?? false,
      resultHead: record.resultHead,
    },
  });
}

/**
 * One run's newest calls, oldest first, bounded here rather than after: a long run keeps more
 * records than one read should return.
 */
export async function runToolCallRecords(
  prisma: Pick<PrismaClient, "toolCallRecord">,
  scope: { spaceId: string; runId: string; limit?: number },
): Promise<ToolCallRecord[]> {
  const rows = await prisma.toolCallRecord.findMany({
    where: { spaceId: scope.spaceId, runId: scope.runId },
    select: {
      executionId: true,
      tool: true,
      durationMs: true,
      outcome: true,
      arguments: true,
      error: true,
      resultBytes: true,
      resultShortened: true,
      resultHead: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(scope.limit ?? TOOL_CALL_RECORDS_MAX, TOOL_CALL_RECORDS_MAX),
  });
  return rows
    .map((row) => ({
      executionId: row.executionId,
      tool: row.tool,
      durationMs: row.durationMs,
      outcome: row.outcome as ToolCallOutcome,
      ...(row.arguments === null ? {} : { arguments: row.arguments }),
      ...(row.error === null ? {} : { error: row.error }),
      ...(row.resultBytes === null ? {} : { resultBytes: row.resultBytes }),
      ...(row.resultShortened ? { resultShortened: true } : {}),
      ...(row.resultHead === null ? {} : { resultHead: row.resultHead }),
    }))
    .reverse();
}

/** Whether this Space keeps the traces at all; a privacy-sensitive one turns them off. */
export async function spaceKeepsToolCallRecords(
  prisma: Pick<PrismaClient, "space">,
  spaceId: string,
): Promise<boolean> {
  const space = await prisma.space.findUnique({
    where: { id: spaceId },
    select: { keepToolCallRecords: true },
  });
  return space?.keepToolCallRecords ?? false;
}

export async function setSpaceKeepsToolCallRecords(
  prisma: Pick<PrismaClient, "space">,
  spaceId: string,
  keeps: boolean,
): Promise<void> {
  await prisma.space.update({ where: { id: spaceId }, data: { keepToolCallRecords: keeps } });
}

/** How many records one sweep deletes at once, so a backlog never holds a connection for long. */
const SWEEP_BATCH = 1_000;
/** How many batches one sweep takes before leaving the rest to the next one. */
const SWEEP_MAX_BATCHES = 20;

/**
 * Deletes the traces past their retention, oldest first and a batch at a time, so a sweep after a
 * long outage pages through a backlog instead of holding one statement over all of it. Returns how
 * many it deleted. Runs as the system, past the tenant policy every other reader obeys.
 */
export async function deleteExpiredToolCallRecords(
  prisma: Pick<PrismaClient, "toolCallRecord">,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - TOOL_CALL_RECORD_RETENTION_MS);
  let deleted = 0;
  for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch += 1) {
    const expired = await prisma.toolCallRecord.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: SWEEP_BATCH,
    });
    if (expired.length === 0) break;
    const removed = await prisma.toolCallRecord.deleteMany({
      where: { id: { in: expired.map((row) => row.id) } },
    });
    deleted += removed.count;
    if (expired.length < SWEEP_BATCH) break;
  }
  return deleted;
}
