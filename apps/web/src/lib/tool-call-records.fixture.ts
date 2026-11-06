import type { ToolCallRecord } from "@rakazo/contracts";
import { recordToolCallEvent } from "./tool-call-records";

/**
 * For tests and screenshot fixtures: replays the thread events that leave a run with these
 * records, through the same path live events take.
 */
export function replayToolCallRecords(runId: string, records: readonly ToolCallRecord[]): void {
  for (const record of records) {
    const { executionId, name } = record;
    const apply = (type: string, payload: Record<string, unknown>) =>
      recordToolCallEvent({ type, runId, payload } as Parameters<typeof recordToolCallEvent>[0]);
    apply("agent.tool.called", {
      name,
      executionId,
      ...(record.input ? { input: record.input } : {}),
      ...(record.withheld ? { withheld: true } : {}),
    });
    if (record.command !== undefined || record.exitCode !== undefined) {
      apply("computer.command", {
        executionId,
        kind: record.command !== undefined ? "shell" : name,
        command: record.command ?? "",
        cwd: ".",
        status: record.status,
        exitCode: record.exitCode ?? null,
        output: record.command !== undefined ? (record.output ?? "") : "",
      });
    }
    if (record.status === "done" && (record.command === undefined || record.outcome)) {
      apply("agent.tool.completed", {
        name,
        executionId,
        outcome: record.outcome ?? "succeeded",
        ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
        ...(record.error === undefined ? {} : { error: record.error }),
        ...(record.command === undefined && record.output ? { preview: record.output } : {}),
      });
    }
  }
}
