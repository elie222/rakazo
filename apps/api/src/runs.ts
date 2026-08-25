import type { Actor, RunActivityRow } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

const RECENT_LIMIT = 20;
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

function promptSnippet(prompt: string, max = 120): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

export async function listWorkspaceRuns(
  prisma: PrismaClient,
  actor: Actor,
  filter: "active" | "recent",
): Promise<RunActivityRow[]> {
  const rows = await prisma.run.findMany({
    where: {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      bot: { archivedAt: null },
      ...(filter === "active"
        ? { status: { in: [...ACTIVE_RUN_STATUSES] } }
        : { status: { in: [...TERMINAL_STATUSES] } }),
    },
    include: {
      bot: { select: { name: true, archivedAt: true } },
      task: { select: { prompt: true } },
      thread: {
        select: {
          groupId: true,
          group: { select: { name: true } },
        },
      },
    },
    orderBy:
      filter === "active"
        ? [{ updatedAt: "desc" }, { id: "desc" }]
        : [{ completedAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    take: filter === "recent" ? RECENT_LIMIT : undefined,
  });

  return rows.map((row) => ({
    runId: row.id,
    botId: row.botId,
    botName: row.bot.name,
    groupId: row.thread.groupId,
    groupName: row.thread.group?.name ?? null,
    threadId: row.threadId,
    status: row.status as RunActivityRow["status"],
    trigger: row.trigger as RunActivityRow["trigger"],
    promptSnippet: promptSnippet(row.task.prompt),
    updatedAt: (filter === "recent" && row.completedAt
      ? row.completedAt
      : row.updatedAt
    ).toISOString(),
  }));
}
