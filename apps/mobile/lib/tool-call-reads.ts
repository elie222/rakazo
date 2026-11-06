import type { ToolCallRecord } from "@rakazo/contracts";
import { toolCallReadIsFinal } from "@rakazo/core";
import { registerSessionDiskCache } from "./session";

/** Finished runs whose calls were read, newest last. */
const FINISHED_RUNS_KEPT = 8;
const finishedRunReads = new Map<string, Promise<ToolCallRecord[]>>();

registerSessionDiskCache(() => finishedRunReads.clear());

/**
 * The calls of a finished run, read once and shared by every step opened in it. A read that
 * cannot stand for the finished run, such as one taken mid-run, and a failed read are read
 * again.
 */
export async function readFinishedRunToolCalls(
  runId: string,
  executionId: string,
  read: () => Promise<ToolCallRecord[]>,
): Promise<ToolCallRecord[]> {
  const known = finishedRunReads.get(runId);
  if (known) {
    const records = await known.catch(() => undefined);
    if (toolCallReadIsFinal(records, executionId) && records) return records;
    if (finishedRunReads.get(runId) === known) finishedRunReads.delete(runId);
  }
  const pending = read();
  finishedRunReads.set(runId, pending);
  pending.catch(() => {
    if (finishedRunReads.get(runId) === pending) finishedRunReads.delete(runId);
  });
  while (finishedRunReads.size > FINISHED_RUNS_KEPT) {
    const oldest = finishedRunReads.keys().next().value;
    if (oldest === undefined) break;
    finishedRunReads.delete(oldest);
  }
  return pending;
}
