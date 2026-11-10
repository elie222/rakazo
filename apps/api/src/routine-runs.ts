import { ORPCError } from "@orpc/server";
import type { Actor, RoutineHistory, RoutineRun, RoutineRunCursor } from "@rakazo/contracts";
import { MessageBlock, ROUTINE_HISTORY_PAGE_SIZE } from "@rakazo/contracts";
import { RUN_REPLY_EVENT, runFailureError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";

export async function listRoutineRuns(
  prisma: PrismaClient,
  actor: Actor,
  routineId: string,
  before?: RoutineRunCursor,
  limit = ROUTINE_HISTORY_PAGE_SIZE,
): Promise<RoutineHistory> {
  const routine = await prisma.routine.findFirst({
    where: {
      id: routineId,
      spaceId: actor.spaceId,
      bot: { archivedAt: null },
    },
    select: { botId: true },
  });
  if (!routine) throw new ORPCError("NOT_FOUND");

  const rows = await prisma.run.findMany({
    where: {
      routineId,
      botId: routine.botId,
      spaceId: actor.spaceId,
      ...(before
        ? {
            OR: [
              { createdAt: { lt: new Date(before.createdAt) } },
              { createdAt: new Date(before.createdAt), id: { lt: before.id } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      botId: true,
      threadId: true,
      thread: { select: { groupId: true } },
      status: true,
      error: true,
      lateSince: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const runs = rows.slice(0, limit);
  const last = runs.at(-1);
  const nextCursor =
    rows.length > limit && last ? { id: last.id, createdAt: last.createdAt.toISOString() } : null;
  // Routine runs can finish silently. A chat link opens the first message a run posted.
  const messages = runs.length
    ? await prisma.$queryRaw<Array<{ id: string; runId: string; threadId: string }>>(Prisma.sql`
        SELECT DISTINCT ON (m."runId") m.id, m."runId", m."threadId"
        FROM messages m
        INNER JOIN runs r ON r.id = m."runId" AND r."threadId" = m."threadId"
        INNER JOIN threads t ON t.id = m."threadId"
        WHERE r.id IN (${Prisma.join(runs.map((run) => run.id))})
          AND r."spaceId" = ${actor.spaceId}
          AND t."spaceId" = ${actor.spaceId}
          AND m.role = 'bot'
        ORDER BY m."runId", m.seq
      `)
    : [];
  const replyByRun = new Map(messages.map((message) => [message.runId, message.id]));
  // A silent run kept its reply out of the chat; the history is where it shows.
  const heldReplies = runs.length
    ? await prisma.event.findMany({
        where: {
          spaceId: actor.spaceId,
          type: RUN_REPLY_EVENT,
          runId: { in: runs.map((run) => run.id) },
        },
        select: { runId: true, payload: true },
      })
    : [];
  const heldReplyByRun = new Map(
    heldReplies.flatMap((event) => {
      const blocks = MessageBlock.array().safeParse(
        (event.payload as { blocks?: unknown } | null)?.blocks,
      );
      return event.runId && blocks.success ? [[event.runId, blocks.data] as const] : [];
    }),
  );
  return {
    nextCursor,
    runs: runs.map((run) => ({
      id: run.id,
      botId: run.botId,
      groupId: run.thread.groupId,
      status: run.status as RoutineRun["status"],
      error: runFailureError({ type: `run.${run.status}`, payload: { error: run.error } }),
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      lateSince: run.lateSince?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      messageId: replyByRun.get(run.id) ?? null,
      ...(heldReplyByRun.has(run.id) ? { reply: heldReplyByRun.get(run.id) } : {}),
    })),
  };
}
