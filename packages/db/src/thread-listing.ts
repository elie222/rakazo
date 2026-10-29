import { ACTIVE_RUN_STATUSES, BACKGROUND_RUN_TRIGGERS, plainTextFromMarkdown } from "@rakazo/core";

import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

export const activeRunStatuses = [...ACTIVE_RUN_STATUSES];
const backgroundRunTriggers = [...BACKGROUND_RUN_TRIGGERS];
const userVisibleBotRunTriggers = ["bot_message", ...BACKGROUND_RUN_TRIGGERS];

/**
 * Active conversational/foreground runs for a bot's sidebar status. Background
 * ticket runs keep working silently, so they must not make the avatar spin.
 */
export const activeRunSelection = {
  where: {
    status: { in: activeRunStatuses },
    trigger: { notIn: backgroundRunTriggers },
  },
  orderBy: { createdAt: "desc" as const },
  select: { status: true },
} as const;

/** Waiting, running, then leased work wins over queued work, regardless of creation order. */
export function primaryActiveRun<T extends { status: string }>(runs: readonly T[]): T | undefined {
  return (
    runs.find((run) => run.status === "waiting_takeover" || run.status === "waiting_input") ??
    runs.find((run) => run.status === "running") ??
    runs.find((run) => run.status === "leased") ??
    runs[0]
  );
}

/** Latest user-visible run per thread, bounded in SQL rather than by Prisma in memory. */
export async function withLatestBotRuns<T extends { thread: { id: string } | null }>(
  prisma: PrismaClient,
  parents: T[],
) {
  const threadIds = parents.flatMap((parent) => (parent.thread ? [parent.thread.id] : []));
  const loaded =
    threadIds.length === 0
      ? []
      : await prisma.$queryRaw<Array<{ id: string; threadId: string; status: string }>>(Prisma.sql`
    SELECT r.id, r."threadId", r.status
    FROM unnest(${threadIds}::text[]) AS t(id)
    CROSS JOIN LATERAL (
      SELECT id, "threadId", status
      FROM runs
      WHERE "threadId" = t.id AND trigger NOT IN (${Prisma.join(userVisibleBotRunTriggers)})
      ORDER BY "createdAt" DESC, id DESC
      LIMIT 1
    ) r
  `);
  const byThread = new Map(loaded.map((run) => [run.threadId, run]));
  return parents.map((parent) => {
    const run = parent.thread ? byThread.get(parent.thread.id) : undefined;
    return {
      ...parent,
      thread: parent.thread ? { ...parent.thread, runs: run ? [run] : [] } : null,
    };
  });
}

export function previewFromBlocks(blocks: unknown): string {
  const rows = Array.isArray(blocks) ? blocks : [];
  for (const block of rows) {
    if (
      block &&
      typeof block === "object" &&
      "text" in block &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return plainTextFromMarkdown((block as { text: string }).text);
    }
  }
  return "";
}
