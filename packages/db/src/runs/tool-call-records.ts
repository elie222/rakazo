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
 * Keeps one call's trace, unless its run was cancelled first. A call that finishes after its run
 * was stopped or its conversation cleared has nothing left to explain, as its audit event has no
 * history to join; the run is locked FOR SHARE, so a clear that cancels it either waits for this
 * row and deletes it, or commits first and this writes nothing. Callers keep writes best effort.
 */
export async function createToolCallRecord(
  prisma: Pick<PrismaClient, "$transaction">,
  record: ToolCallRecordInput,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const [run] = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM runs WHERE id = ${record.runId} FOR SHARE`;
    if (!run || run.status === "cancelled") return;
    await tx.toolCallRecord.create({
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
  });
}

/**
 * One run's newest calls, oldest first, bounded here rather than after: a long run keeps more
 * records than one read should return. `explainedOnly` keeps just the calls that need explaining
 * (failed or shortened; a paused call waits on a person, not on an explanation), so a run that
 * failed once and then worked a dozen times still shows why it failed.
 */
export async function runToolCallRecords(
  prisma: Pick<PrismaClient, "toolCallRecord">,
  scope: { spaceId: string; runId: string; limit?: number; explainedOnly?: boolean },
): Promise<ToolCallRecord[]> {
  const rows = await prisma.toolCallRecord.findMany({
    where: {
      spaceId: scope.spaceId,
      runId: scope.runId,
      ...(scope.explainedOnly ? { OR: [{ outcome: "failed" }, { resultShortened: true }] } : {}),
    },
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
const DAY_MS = 24 * 60 * 60_000;

/**
 * Deletes the traces past their retention, oldest first and a batch at a time, so a sweep after a
 * long outage pages through a backlog instead of holding one statement over all of it. It runs
 * until nothing is past retention or `signal` aborts between batches, so a busy deployment never
 * builds a backlog one sweep cannot clear. A deployment that keeps chat history for fewer days
 * (`chatHistoryDays`) keeps the traces no longer, as they repeat what that history said. Returns how
 * many it deleted. Runs as the system, past the tenant policy every other reader obeys.
 */
export async function deleteExpiredToolCallRecords(
  prisma: Pick<PrismaClient, "toolCallRecord">,
  options: { now?: Date; signal?: AbortSignal; chatHistoryDays?: number | null } = {},
): Promise<number> {
  const { now = new Date(), signal, chatHistoryDays } = options;
  const retentionMs = Math.min(
    TOOL_CALL_RECORD_RETENTION_MS,
    chatHistoryDays ? chatHistoryDays * DAY_MS : Number.POSITIVE_INFINITY,
  );
  const cutoff = new Date(now.getTime() - retentionMs);
  let deleted = 0;
  while (!signal?.aborted) {
    const expired = await prisma.toolCallRecord.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      // Deleted rows leave the next query, so the id tiebreak only keeps each batch's order stable.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
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
