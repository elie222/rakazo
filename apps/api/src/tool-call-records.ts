import type { ToolCallRecord } from "@rakazo/contracts";
import { foldToolCallRecords } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";

/** Calls read for one run: enough for a long run, bounded so a runaway one stays cheap. */
const TOOL_CALLS_MAX = 2_000;

type EventRow = { type: string; payload: unknown; seq: number };

/**
 * What each tool call of a run did, for its first calls up to the limit. The limit counts
 * calls, not events, so a call within it always comes with its completion and its command
 * output, and a call past it is left out whole rather than shown half done. A shell command
 * streams its output in many events, so only one is read per command: its final frame when it
 * finished, since a streamed frame can land after it, else its newest.
 */
export async function loadToolCallRecords(
  prisma: Pick<PrismaClient, "event" | "$queryRaw">,
  threadId: string,
  runId: string,
): Promise<ToolCallRecord[]> {
  const calls = await prisma.event.findMany({
    where: { threadId, runId, type: "agent.tool.called" },
    orderBy: { seq: "asc" },
    take: TOOL_CALLS_MAX,
    select: { type: true, payload: true, seq: true },
  });
  const executionIds = [
    ...new Set(
      calls.flatMap((row) => {
        const id = (row.payload as { executionId?: unknown } | null)?.executionId;
        return typeof id === "string" ? [id] : [];
      }),
    ),
  ];
  if (executionIds.length === 0) return [];
  const [completions, commands] = await Promise.all([
    prisma.$queryRaw<EventRow[]>(Prisma.sql`
      SELECT type, payload, seq
      FROM events
      WHERE "threadId" = ${threadId} AND "runId" = ${runId} AND type = 'agent.tool.completed'
        AND payload->>'executionId' = ANY(${executionIds}::text[])
      ORDER BY seq ASC
      LIMIT ${TOOL_CALLS_MAX * 2}
    `),
    prisma.$queryRaw<EventRow[]>(Prisma.sql`
      SELECT DISTINCT ON (payload->>'executionId') type, payload, seq
      FROM events
      WHERE "threadId" = ${threadId} AND "runId" = ${runId} AND type = 'computer.command'
        AND payload->>'executionId' = ANY(${executionIds}::text[])
      ORDER BY payload->>'executionId', (payload->>'status' = 'done') DESC, seq DESC
      LIMIT ${TOOL_CALLS_MAX}
    `),
  ]);
  const events: EventRow[] = [...calls, ...completions, ...commands].sort((a, b) => a.seq - b.seq);
  return foldToolCallRecords(events);
}
