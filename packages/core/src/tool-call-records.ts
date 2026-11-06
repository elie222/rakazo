import type { ToolCallRecord } from "@rakazo/contracts";
import { ComputerCommandSchema } from "@rakazo/contracts";

/** Events that say what a tool call did: its call, its completion audit and any shell output it streamed. */
export function isToolCallRecordEvent(event: { type: string }): boolean {
  return (
    event.type === "agent.tool.called" ||
    event.type === "agent.tool.completed" ||
    event.type === "computer.command"
  );
}

/**
 * Tool output for people: JSON comes back indented, anything else as it was. A shell prints
 * text, so this only changes what structured tools return.
 */
export function prettyToolText(text: string): string {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
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
  if (event.type === "agent.tool.called") {
    const payload = asRecord(event.payload);
    if (typeof payload.executionId !== "string") return undefined;
    const prior = records.get(payload.executionId);
    return {
      ...prior,
      executionId: payload.executionId,
      name: typeof payload.name === "string" ? payload.name : (prior?.name ?? ""),
      status: prior?.status ?? "running",
      ...(typeof payload.input === "string" ? { input: payload.input } : {}),
    };
  }
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

/**
 * What each live tool call did, by run, fed from a thread's realtime events. Calls that
 * finished before the client connected are not here; the activity view fetches those on demand.
 */
export function createToolCallRecordStore() {
  const byRun = new Map<string, ReadonlyMap<string, ToolCallRecord>>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    /** Applies a thread event; events that say nothing about a call are ignored. */
    record(event: { type: string; runId?: string | null; payload?: unknown }): void {
      if (!event.runId || !isToolCallRecordEvent(event)) return;
      const records = byRun.get(event.runId) ?? new Map<string, ToolCallRecord>();
      const next = reduceToolCallRecord(records, { type: event.type, payload: event.payload });
      if (!next) return;
      byRun.set(event.runId, new Map(records).set(next.executionId, next));
      notify();
    },
    /** Puts records in place of a run's events, for fixtures and tests. */
    seed(runId: string, records: readonly ToolCallRecord[]): void {
      byRun.set(runId, new Map(records.map((record) => [record.executionId, record])));
      notify();
    },
    get(runId: string): ReadonlyMap<string, ToolCallRecord> | undefined {
      return byRun.get(runId);
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear(): void {
      byRun.clear();
      notify();
    },
  };
}

/** A fenced code block whose fence outruns any backtick run inside the code. */
export function fencedCode(code: string, language: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${code.replace(/\n$/, "")}\n${fence}`;
}

/**
 * What a call ran and returned, as the markdown the chat's own code blocks draw: a shell
 * command and its output share one console block; another tool shows its arguments as JSON
 * and its result as JSON when it parses, else as text. Nothing when the record has neither.
 */
export function toolCallMarkdown(
  record: Pick<ToolCallRecord, "command" | "input" | "output">,
): string {
  const output = prettyToolText(record.output ?? "");
  if (record.command !== undefined) {
    const prompt = `$ ${record.command}`;
    return fencedCode(output ? `${prompt}\n${output}` : prompt, "console");
  }
  const blocks: string[] = [];
  if (record.input) blocks.push(fencedCode(record.input, "json"));
  if (output) blocks.push(fencedCode(output, output !== record.output ? "json" : "text"));
  return blocks.join("\n\n");
}
