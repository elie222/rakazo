import type { ToolCallRecord } from "@rakazo/contracts";
import { foldToolCallRecords } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

/** Calls read for one run: enough for a long run, bounded so a runaway one stays cheap. */
const TOOL_CALLS_MAX = 2_000;

/**
 * What each tool call of a run did, for its first calls up to the limit. Each call's own event
 * and its completion say what ran. A shell that returned while still running can also have a
 * terminal command event. Running output frames are never loaded. Use the client to open
 * encrypted event payloads.
 */
export async function loadToolCallRecords(
  prisma: Pick<PrismaClient, "event">,
  threadId: string,
  runId: string,
): Promise<ToolCallRecord[]> {
  const select = { type: true, payload: true, seq: true } as const;
  const [calls, completions] = await Promise.all([
    prisma.event.findMany({
      where: { threadId, runId, type: "agent.tool.called" },
      orderBy: { seq: "asc" },
      take: TOOL_CALLS_MAX,
      select,
    }),
    // A call completes once, or twice when it paused and later finished.
    prisma.event.findMany({
      where: { threadId, runId, type: "agent.tool.completed" },
      orderBy: { seq: "asc" },
      take: TOOL_CALLS_MAX * 2,
      select,
    }),
  ]);
  const called = new Set(calls.map((row) => executionIdOf(row.payload)));
  const runningShells = new Set(
    completions
      .filter(({ payload }) => (payload as { exitCode?: unknown } | null)?.exitCode === null)
      .map(({ payload }) => executionIdOf(payload))
      .filter((id) => called.has(id)),
  );
  const terminalCommands = runningShells.size
    ? await prisma.event.findMany({
        where: {
          threadId,
          runId,
          type: "computer.command",
          OR: [
            { payload: { path: ["state"], equals: "tool-shell-finished" } },
            // Older unencrypted command events still carry their own status.
            { payload: { path: ["status"], equals: "done" } },
          ],
        },
        orderBy: { seq: "asc" },
        take: TOOL_CALLS_MAX,
        select,
      })
    : [];
  // Only calls within the limit, each with its completion, so none shows half done.
  const events = [
    ...calls,
    ...completions.filter((row) => called.has(executionIdOf(row.payload))),
    ...terminalCommands.filter((row) => runningShells.has(executionIdOf(row.payload))),
  ].sort((a, b) => a.seq - b.seq);
  return foldToolCallRecords(events);
}

function executionIdOf(payload: unknown): string | undefined {
  const id = (payload as { executionId?: unknown } | null)?.executionId;
  return typeof id === "string" ? id : undefined;
}

/**
 * A record as someone who did not start the run sees it: without the call's arguments,
 * returned text or error. A shell's command and output stay, since the thread's live activity
 * feed already shows them to every reader.
 */
export function withheldToolCallRecord(record: ToolCallRecord): ToolCallRecord {
  const { input: _input, error: _error, output, ...rest } = record;
  return {
    ...rest,
    ...(record.command !== undefined && output !== undefined ? { output } : {}),
    withheld: true,
  };
}

/** A finished run's call left marked running, such as a shell that outlived it, is over. */
export function settledToolCallRecord(record: ToolCallRecord): ToolCallRecord {
  return record.status === "running" ? { ...record, status: "done" } : record;
}
