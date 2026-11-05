import type { ToolCallRecord } from "@rakazo/contracts";
import { ComputerCommandSchema } from "@rakazo/contracts";

/** Events that say what a tool call did: its completion audit and any shell output it streamed. */
export function isToolCallRecordEvent(event: { type: string }): boolean {
  return event.type === "agent.tool.completed" || event.type === "computer.command";
}

/**
 * Folds a run's completion audits and streamed shell commands into one record per call, in
 * the order the calls finished or started printing. A shell command keeps running after its
 * tool returned early, so its own events decide when it is done.
 */
export function foldToolCallRecords(
  events: readonly { type: string; payload: unknown }[],
): ToolCallRecord[] {
  const byId = new Map<string, ToolCallRecord>();
  for (const event of events) {
    const next = reduceToolCallRecord(byId, event);
    if (next) byId.set(next.executionId, next);
  }
  return [...byId.values()];
}

/** The record one event leaves for its call, given the records so far; nothing for other events. */
export function reduceToolCallRecord(
  records: ReadonlyMap<string, ToolCallRecord>,
  event: { type: string; payload: unknown },
): ToolCallRecord | undefined {
  if (event.type === "agent.tool.completed") {
    const payload = asRecord(event.payload);
    if (typeof payload.executionId !== "string") return undefined;
    const prior = records.get(payload.executionId);
    const durationMs =
      typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs)
        ? Math.max(0, Math.round(payload.durationMs))
        : undefined;
    return {
      ...prior,
      executionId: payload.executionId,
      name: typeof payload.name === "string" ? payload.name : (prior?.name ?? ""),
      status: prior?.command === undefined ? "done" : prior.status,
      outcome:
        payload.outcome === "error" || payload.outcome === "paused" ? payload.outcome : "succeeded",
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(typeof payload.error === "string" ? { error: payload.error } : {}),
      // A shell command's own output already says what it printed.
      ...(prior?.output === undefined && typeof payload.preview === "string"
        ? { output: payload.preview }
        : {}),
    };
  }
  if (event.type === "computer.command") {
    const parsed = ComputerCommandSchema.safeParse(event.payload);
    if (!parsed.success) return undefined;
    const command = parsed.data;
    const prior = records.get(command.executionId);
    if (prior?.command !== undefined && prior.status === "done" && command.status === "running")
      return undefined;
    return {
      ...prior,
      executionId: command.executionId,
      name: prior?.name ?? command.kind,
      status: command.status,
      ...(command.kind === "shell" ? { command: command.command } : {}),
      output: command.output,
      exitCode: command.exitCode,
    };
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
