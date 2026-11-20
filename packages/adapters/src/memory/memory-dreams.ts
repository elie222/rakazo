import type { JobPublisher } from "@rakazo/adapter-kit";
import { RetryJobLaterError } from "@rakazo/adapter-kit";
import { ACTIVE_RUN_STATUSES, blocksToAgentHistoryText, MEMORY_DREAM_TRIGGER } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { storedMessageBlocks } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { wakeRun } from "../runs/wakeups/wake-run.js";
import { memoryDreamPrompt } from "./memory-dream.prompt.js";

/** One consolidation per bot per night, and a day's wait after one starts. */
export const MEMORY_DREAM_COOLDOWN_MS = 12 * 60 * 60_000;
/** A dream run this old is treated as lost, and its backup job starts it again. */
export const MEMORY_DREAM_TIMEOUT_MS = 15 * 60_000;
/** Bots one sweep considers; each needs its own reads and transaction. */
const MEMORY_DREAM_BATCH = 20;
/** User messages one dream reads, and the characters they may take up together. */
const MEMORY_DREAM_MESSAGE_LIMIT = 200;
const MEMORY_DREAM_MESSAGE_BYTES = 32_000;
/** Dreams kept per bot; older ones, with the hidden threads they ran in, are deleted. */
const MEMORY_DREAM_RETENTION = 100;
const NIGHT_START_HOUR = 22;
const NIGHT_END_HOUR = 6;

export type MemoryDreamSkipReason =
  | "off"
  | "not-night"
  | "busy"
  | "no-new-messages"
  | "too-soon"
  | "already-dreamed";

type DreamDeps = {
  prisma: PrismaClient;
  jobs: Pick<JobPublisher, "enqueue" | "enqueueIn">;
  now?: () => Date;
};

function localHour(now: Date, timeZone: string | null | undefined): number {
  try {
    const hour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: timeZone || "UTC",
        hour: "numeric",
        hour12: false,
      }).format(now),
    );
    return Number.isInteger(hour) ? hour % 24 : 0;
  } catch {
    return now.getUTCHours();
  }
}

function isNight(hour: number): boolean {
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

/** The user's own words since the last dream, bounded to what one consolidation reads. */
async function recentUserMessages(
  prisma: PrismaClient,
  threadId: string,
  sinceSeq: number | null,
): Promise<{ id: string; seq: number; text: string }[]> {
  const rows = await prisma.message.findMany({
    where: {
      threadId,
      role: "user",
      ...(sinceSeq === null ? {} : { seq: { gt: sinceSeq } }),
    },
    orderBy: { seq: "asc" },
    take: MEMORY_DREAM_MESSAGE_LIMIT,
    select: { id: true, seq: true, blocks: true },
  });
  const messages = rows.map((row) => ({
    id: row.id,
    seq: row.seq,
    text: blocksToAgentHistoryText(storedMessageBlocks(row)),
  }));
  let used = 0;
  const kept: typeof messages = [];
  for (const message of [...messages].reverse()) {
    used += message.text.length;
    if (used > MEMORY_DREAM_MESSAGE_BYTES) break;
    kept.unshift(message);
  }
  return kept;
}

/**
 * Starts one consolidation run for a bot: a hidden thread, its task and run, the dream record
 * that makes a replay harmless, and the backup job that starts the run again if this process
 * dies before the wake-up lands. The run itself starts before this returns.
 */
async function startMemoryDream(
  deps: DreamDeps,
  input: {
    botId: string;
    spaceId: string;
    userId: string;
    botName: string;
    threadId: string;
    useOwnMemory: boolean;
    useSharedMemory: boolean;
    /** The user-message sequence the previous dream covered; null before the first. */
    sinceSeq: number | null;
    sourceMessageId: string;
    sourceSeq: number;
    now: Date;
  },
): Promise<"started" | "too-soon"> {
  const [documents, messages] = await Promise.all([
    deps.prisma.memoryDocument.findMany({
      where: {
        spaceId: input.spaceId,
        OR: [
          ...(input.useOwnMemory ? [{ scope: "bot", botId: input.botId }] : []),
          ...(input.useSharedMemory ? [{ scope: "user" as const }] : []),
        ],
      },
      select: { scope: true, path: true, content: true },
    }),
    recentUserMessages(deps.prisma, input.threadId, input.sinceSeq),
  ]);
  const ownMemory = documents
    .filter((document) => document.scope === "bot")
    .map((document) => document.content)
    .join("\n\n");
  const sharedMemory = documents
    .filter((document) => document.scope === "user")
    .map((document) => ({ path: document.path, content: document.content }));
  const prompt = memoryDreamPrompt({
    botName: input.botName,
    includeOwn: input.useOwnMemory,
    includeShared: input.useSharedMemory,
    ownMemory,
    sharedMemory,
    messages,
  });
  const cooldownStart = new Date(input.now.getTime() - MEMORY_DREAM_COOLDOWN_MS);
  const started = await deps.prisma.$transaction(async (tx) => {
    // One dream per bot at a time: a sweep, a retry and a backup job all wait here.
    await tx.$queryRaw`SELECT id FROM bots WHERE id = ${input.botId} FOR UPDATE`;
    if (
      await tx.memoryDream.findFirst({
        where: { botId: input.botId, createdAt: { gte: cooldownStart } },
        select: { id: true },
      })
    )
      return null;
    const hiddenThread = await tx.thread.create({
      data: { spaceId: input.spaceId, userId: input.userId, helperBotId: input.botId },
      select: { id: true },
    });
    const task = await tx.task.create({
      data: {
        spaceId: input.spaceId,
        botId: input.botId,
        threadId: hiddenThread.id,
        userId: input.userId,
        prompt,
        status: "queued",
      },
      select: { id: true },
    });
    const run = await tx.run.create({
      data: {
        spaceId: input.spaceId,
        botId: input.botId,
        threadId: hiddenThread.id,
        taskId: task.id,
        userId: input.userId,
        status: "queued",
        trigger: MEMORY_DREAM_TRIGGER,
        sourceMessageId: input.sourceMessageId,
      },
      select: { id: true },
    });
    const dream = await tx.memoryDream.create({
      data: {
        spaceId: input.spaceId,
        botId: input.botId,
        threadId: hiddenThread.id,
        runId: run.id,
        status: "queued",
        sourceSeq: input.sourceSeq,
      },
      select: { id: true },
    });
    await deps.jobs.enqueueIn(tx, {
      name: "memory.dream",
      payload: { dreamId: dream.id },
      replaceKey: `memory-dream:${dream.id}`,
      availableAt: new Date(input.now.getTime() + MEMORY_DREAM_TIMEOUT_MS),
      maxAttempts: 5,
    });
    return { dreamId: dream.id, runId: run.id };
  });
  if (!started) return "too-soon";
  await wakeRun(deps.jobs, started.runId);
  return "started";
}

/**
 * One scheduler pass: bots whose owner's local night is on and that are idle with something new
 * to consolidate. Skips are logged by reason, never with message content.
 */
export async function reconcileMemoryDreams(deps: DreamDeps): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const cooldownStart = new Date(now.getTime() - MEMORY_DREAM_COOLDOWN_MS);
  const bots = await deps.prisma.bot.findMany({
    where: {
      archivedAt: null,
      OR: [{ useOwnMemory: true }, { useSharedMemory: true }],
      thread: { isNot: null },
      runs: { none: { status: { in: [...ACTIVE_RUN_STATUSES] } } },
      memoryDreams: { none: { createdAt: { gte: cooldownStart } } },
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: MEMORY_DREAM_BATCH,
    select: {
      id: true,
      spaceId: true,
      userId: true,
      name: true,
      useOwnMemory: true,
      useSharedMemory: true,
      thread: { select: { id: true } },
    },
  });
  if (!bots.length) return;
  const users = await deps.prisma.user.findMany({
    where: { id: { in: [...new Set(bots.map((bot) => bot.userId))] } },
    select: { id: true, timezone: true },
  });
  const timeZones = new Map(users.map((user) => [user.id, user.timezone]));
  for (const bot of bots) {
    const threadId = bot.thread?.id;
    if (!threadId) continue;
    const skip = (reason: MemoryDreamSkipReason) =>
      getLogger().debug("memory.dream.skipped", { "bot.id": bot.id, reason });
    if (!bot.useOwnMemory && !bot.useSharedMemory) {
      skip("off");
      continue;
    }
    if (!isNight(localHour(now, timeZones.get(bot.userId)))) {
      skip("not-night");
      continue;
    }
    const last = await deps.prisma.memoryDream.findFirst({
      where: { botId: bot.id, status: "completed" },
      orderBy: { createdAt: "desc" },
      select: { sourceSeq: true },
    });
    const messages = await recentUserMessages(deps.prisma, threadId, last?.sourceSeq ?? null);
    if (!messages.length) {
      skip("no-new-messages");
      continue;
    }
    const source = messages[messages.length - 1]!;
    const result = await startMemoryDream(deps, {
      botId: bot.id,
      spaceId: bot.spaceId,
      userId: bot.userId,
      botName: bot.name,
      threadId,
      useOwnMemory: bot.useOwnMemory,
      useSharedMemory: bot.useSharedMemory,
      sinceSeq: last?.sourceSeq ?? null,
      sourceMessageId: source.id,
      sourceSeq: source.seq,
      now,
    });
    if (result === "started")
      getLogger().info("memory.dream.started", { "bot.id": bot.id, "space.id": bot.spaceId });
    else skip("too-soon");
  }
}

/** Settles a dream's record from the run that finished it, once. */
export async function recordMemoryDream(
  prisma: PrismaClient,
  run: { id: string; startedAt?: Date | null },
  outcome: { status: "completed" | "failed"; summary?: string; errorKind?: string },
): Promise<void> {
  const dream = await prisma.memoryDream.findUnique({
    where: { runId: run.id },
    select: { id: true, status: true },
  });
  if (!dream || dream.status !== "queued") return;
  const revisions = await prisma.memoryRevision.findMany({
    where: { sourceRunId: run.id },
    distinct: ["documentId"],
    select: { document: { select: { path: true } } },
  });
  const changedPaths = [...new Set(revisions.map((revision) => revision.document.path))];
  const summary = outcome.summary?.trim();
  await prisma.memoryDream.update({
    where: { id: dream.id },
    data: {
      status: outcome.status,
      summary: summary ? summary.slice(0, 2_000) : null,
      changedPaths,
      errorKind: outcome.errorKind ?? null,
      startedAt: run.startedAt ?? null,
      finishedAt: new Date(),
    },
  });
}

/**
 * The backup job's pass: a queued dream whose run never started starts now, one whose run
 * already ended settles from it, and one still working waits for the next attempt.
 */
export async function settleMemoryDream(deps: DreamDeps, dreamId: string): Promise<void> {
  const dream = await deps.prisma.memoryDream.findUnique({
    where: { id: dreamId },
    select: { id: true, runId: true, status: true },
  });
  if (!dream || dream.status !== "queued") return;
  if (!dream.runId) {
    await deps.prisma.memoryDream.update({
      where: { id: dream.id },
      data: { status: "failed", errorKind: "missing-run", finishedAt: new Date() },
    });
    return;
  }
  const run = await deps.prisma.run.findUnique({
    where: { id: dream.runId },
    select: { id: true, status: true, startedAt: true },
  });
  if (!run) {
    await deps.prisma.memoryDream.update({
      where: { id: dream.id },
      data: { status: "failed", errorKind: "missing-run", finishedAt: new Date() },
    });
    return;
  }
  if (run.status === "queued") {
    await wakeRun(deps.jobs, run.id);
    return;
  }
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    await recordMemoryDream(deps.prisma, run, {
      status: run.status === "completed" ? "completed" : "failed",
      errorKind: run.status === "completed" ? undefined : "interrupted",
    });
    return;
  }
  throw new RetryJobLaterError(MEMORY_DREAM_TIMEOUT_MS);
}

/** Keeps the newest records per bot and deletes the hidden threads older ones ran in. */
export async function pruneMemoryDreams(prisma: PrismaClient): Promise<void> {
  const stale = await prisma.$queryRaw<Array<{ id: string; threadId: string | null }>>`
    with ranked as (
      select id, "threadId", row_number() over (
        partition by "botId" order by "createdAt" desc, id desc
      ) as position
      from memory_dreams
    )
    select id, "threadId" from ranked where position > ${MEMORY_DREAM_RETENTION}
  `;
  if (!stale.length) return;
  await prisma.memoryDream.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
  const threadIds = stale.flatMap((row) => (row.threadId ? [row.threadId] : []));
  if (threadIds.length) await prisma.thread.deleteMany({ where: { id: { in: threadIds } } });
}

/** The records the Memory page lists, newest first. */
export async function listMemoryDreams(
  prisma: PrismaClient,
  input: { spaceId: string; botId: string; limit?: number; cursor?: string },
) {
  const take = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const rows = await prisma.memoryDream.findMany({
    where: { spaceId: input.spaceId, botId: input.botId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      status: true,
      summary: true,
      changedPaths: true,
      errorKind: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    summary: row.summary,
    changedPaths: row.changedPaths,
    errorKind: row.errorKind,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}
