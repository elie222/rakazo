import { ORPCError } from "@orpc/server";
import type { Actor, RoutineHistory, RoutineRun, RoutineRunCursor } from "@rakazo/contracts";
import { ROUTINE_HISTORY_PAGE_SIZE } from "@rakazo/contracts";
import { runFailureError } from "@rakazo/core";
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
      sourceMessage: { select: { runId: true, seq: true } },
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
  // A run handed to the chat's working run links to that run's first reply after the hand-off.
  const handedReplies = await Promise.all(
    runs.map(async (run) => {
      const handedTo = run.sourceMessage?.runId;
      if (!handedTo || handedTo === run.id) return null;
      const reply = await prisma.message.findFirst({
        where: {
          runId: handedTo,
          threadId: run.threadId,
          role: "bot",
          seq: { gt: run.sourceMessage!.seq },
          thread: { spaceId: actor.spaceId },
        },
        orderBy: { seq: "asc" },
        select: { id: true },
      });
      return reply ? ([run.id, reply.id] as const) : null;
    }),
  );
  for (const handed of handedReplies) if (handed) replyByRun.set(handed[0], handed[1]);
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
    })),
  };
}
