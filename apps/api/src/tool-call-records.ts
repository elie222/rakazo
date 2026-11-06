import type { ToolCallRecord } from "@rakazo/contracts";
import { foldToolCallRecords } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";

/** Enough call and completion events for a long run: two per call. */
const TOOL_CALL_EVENTS = 4_000;

type EventRow = { type: string; payload: unknown; seq: number };

/**
 * What each tool call of a run did. A shell command streams its output in many events, so
 * only its newest one is read; a finished command is then never cut off by the limit, and a
 * long-running one costs one row instead of a frame every few hundred milliseconds.
 */
export async function loadToolCallRecords(
  prisma: Pick<PrismaClient, "event" | "$queryRaw">,
  threadId: string,
  runId: string,
): Promise<ToolCallRecord[]> {
  const [calls, commands] = await Promise.all([
    prisma.event.findMany({
      where: { threadId, runId, type: { in: ["agent.tool.called", "agent.tool.completed"] } },
      orderBy: { seq: "asc" },
      take: TOOL_CALL_EVENTS,
      select: { type: true, payload: true, seq: true },
    }),
    prisma.$queryRaw<EventRow[]>(Prisma.sql`
      SELECT DISTINCT ON (payload->>'executionId') type, payload, seq
      FROM events
      WHERE "threadId" = ${threadId} AND "runId" = ${runId} AND type = 'computer.command'
      ORDER BY payload->>'executionId', seq DESC
    `),
  ]);
  const events: EventRow[] = [...calls, ...commands].sort((a, b) => a.seq - b.seq);
  return foldToolCallRecords(events);
}
