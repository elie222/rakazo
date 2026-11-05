import type { ProductEvent, ToolCallRecord } from "@rakazo/contracts";
import { isToolCallRecordEvent, reduceToolCallRecord } from "@rakazo/core";

/**
 * What each live tool call did, by run, fed from the thread's realtime events. Calls that
 * finished before the page loaded are not here; the activity view fetches those on demand.
 */
const byRun = new Map<string, ReadonlyMap<string, ToolCallRecord>>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** Applies a thread event to the live records; events that say nothing about a call are ignored. */
export function recordToolCallEvent(event: ProductEvent): void {
  if (!event.runId || !isToolCallRecordEvent(event)) return;
  const records = byRun.get(event.runId) ?? new Map<string, ToolCallRecord>();
  const next = reduceToolCallRecord(records, event);
  if (!next) return;
  byRun.set(event.runId, new Map(records).set(next.executionId, next));
  notify();
}

/** Puts records in place of a run's events, for fixtures and tests. */
export function seedToolCallRecords(runId: string, records: readonly ToolCallRecord[]): void {
  byRun.set(runId, new Map(records.map((record) => [record.executionId, record])));
  notify();
}

export function liveToolCallRecords(
  runId: string,
): ReadonlyMap<string, ToolCallRecord> | undefined {
  return byRun.get(runId);
}

export function subscribeToolCallRecords(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearToolCallRecords(): void {
  byRun.clear();
  notify();
}
