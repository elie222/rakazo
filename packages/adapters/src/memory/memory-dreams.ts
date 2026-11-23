import { createHash } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { RetryJobLaterError } from "@rakazo/adapter-kit";
import type { MemoryDream, MemoryDreamReason } from "@rakazo/contracts";
import { MEMORY_INDEX_PATH, MEMORY_TOKEN_CAPS } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  blocksToAgentHistoryText,
  ClientError,
  MEMORY_DREAM_TRIGGER,
  memoryTokenCount,
  validTimezoneOrUtc,
  wallClock,
  zonedDateTime,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, storedMessageBlocks, withTransactionRetry } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { wakeRun } from "../runs/wakeups/wake-run.js";
import { memoryDreamPrompt } from "./memory-dream.prompt.js";

/** A bot consolidates once it has been quiet this long after the user's last turn. */
export const DREAM_IDLE_MS = 5 * 60_000;
/** Pending user messages that start a run without waiting for the quiet. */
export const DREAM_BATCH_MESSAGES = 8;
/** A person may ask for a dream this soon after one started; the run itself still takes minutes. */
export const MANUAL_DREAM_MIN_INTERVAL_MS = 10 * 60_000;
/** A tidy waits this long after the previous dream, so a full memory is not rewritten in a loop. */
export const MEMORY_TIDY_MIN_INTERVAL_MS = 6 * 60 * 60_000;
/** The share of the bot's own notes that makes a tidy due. */
export const MEMORY_TIDY_FULL_RATIO = 0.9;
/** A dream run this old is treated as lost, and its backup job starts it again. */
export const MEMORY_DREAM_TIMEOUT_MS = 15 * 60_000;
/** Bots one sweep considers; each needs its own reads and transaction. */
const MEMORY_DREAM_BATCH = 20;
/** User messages one dream reads, and the characters they may take up together. */
const MEMORY_DREAM_MESSAGE_LIMIT = 200;
const MEMORY_DREAM_MESSAGE_BYTES = 32_000;
/** Dreams kept per bot; older ones, with the hidden threads they ran in, are deleted. */
const MEMORY_DREAM_RETENTION = 100;
/** Lines one dream shows per side; the record is a log, not a copy. */
const MEMORY_DREAM_LINE_LIMIT = 50;

export type MemoryDreamSkipReason =
  | "off"
  | "busy"
  | "no-new-messages"
  | "waiting"
  | "too-soon"
  | "already-dreamed"
  | "empty";

type DreamDeps = {
  prisma: PrismaClient;
  jobs: Pick<JobPublisher, "enqueue" | "enqueueIn">;
  now?: () => Date;
};

/** A stable fingerprint of the notes, so a tidy runs only after they change. */
function memoryTidiedHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** The owner's calendar day, which bounds one review. */
function localDay(instant: Date, timezone: string): string {
  return wallClock(instant, timezone).slice(0, 10);
}

function dreamReason(value: string | null): MemoryDreamReason {
  return value === "batch" || value === "tidy" || value === "review" || value === "manual"
    ? value
    : "idle";
}

/** Meaningful note lines: no blanks, and surrounding space is not part of the fact. */
function noteLines(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** What one write added and removed, as a multiset of lines. */
function lineDiff(before: string, after: string): { added: string[]; archived: string[] } {
  const remaining = new Map<string, number>();
  for (const line of noteLines(before)) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of noteLines(after)) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else added.push(line);
  }
  const archived: string[] = [];
  for (const [line, count] of remaining)
    for (let index = 0; index < count; index += 1) archived.push(line);
  return { added, archived };
}

/** The user's own words since the last dream, bounded to what one consolidation reads. */
async function recentUserMessages(
  prisma: PrismaClient,
  threadId: string,
  sinceSeq: number | null,
): Promise<{ id: string; seq: number; createdAt: Date; text: string }[]> {
  const rows = await prisma.message.findMany({
    where: {
      threadId,
      role: "user",
      ...(sinceSeq === null ? {} : { seq: { gt: sinceSeq } }),
    },
    orderBy: { seq: "asc" },
    take: MEMORY_DREAM_MESSAGE_LIMIT,
    select: { id: true, seq: true, blocks: true, createdAt: true },
  });
  const messages = rows.map((row) => ({
    id: row.id,
    seq: row.seq,
    createdAt: row.createdAt,
    text: blocksToAgentHistoryText(storedMessageBlocks(row)),
  }));
  // Oldest first, so the cursor (the last kept message's seq) never passes a message the dream
  // did not read. A single message over the budget is truncated rather than dropped, or the
  // oldest pending messages would never be consolidated.
  let used = 0;
  const kept: typeof messages = [];
  for (const message of messages) {
    const remaining = MEMORY_DREAM_MESSAGE_BYTES - used;
    if (remaining <= 0) break;
    const characters = [...message.text];
    const keptCharacters = characters.slice(0, remaining);
    const text = keptCharacters.join("");
    kept.push(keptCharacters.length === characters.length ? message : { ...message, text });
    used += keptCharacters.length;
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
    reason: MemoryDreamReason;
    /** The owner's zone, which dates a review's notes. */
    timezone: string;
    threadId: string;
    useOwnMemory: boolean;
    useSharedMemory: boolean;
    /** The user-message sequence the previous dream covered; null before the first. */
    sinceSeq: number | null;
    sourceMessageId: string | null;
    sourceSeq: number | null;
    /** A dream started or requested this recently is not started again. */
    cooldownMs: number;
    now: Date;
  },
): Promise<{ dreamId: string; runId: string } | "too-soon"> {
  const [documents, messages] = await Promise.all([
    deps.prisma.memoryDocument.findMany({
      where: {
        spaceId: input.spaceId,
        OR: [
          ...(input.useOwnMemory ? [{ scope: "bot", botId: input.botId }] : []),
          ...(input.useSharedMemory ? [{ scope: "user" as const }] : []),
        ],
      },
      select: { scope: true, path: true, description: true, content: true },
    }),
    recentUserMessages(deps.prisma, input.threadId, input.sinceSeq),
  ]);
  const ownMemory = documents
    .filter((document) => document.scope === "bot")
    .map((document) => document.content)
    .join("\n\n");
  const sharedMemory = documents
    .filter((document) => document.scope === "user")
    .map((document) => ({
      path: document.path,
      description: document.description,
      content: document.content,
    }));
  const prompt = memoryDreamPrompt({
    botName: input.botName,
    reason: input.reason,
    includeOwn: input.useOwnMemory,
    includeShared: input.useSharedMemory,
    ownMemory,
    sharedMemory,
    messages,
    reviewDate:
      input.reason === "review"
        ? { day: localDay(input.now, input.timezone), timezone: input.timezone }
        : undefined,
  });
  const cooldownStart = new Date(input.now.getTime() - input.cooldownMs);
  const started = await deps.prisma.$transaction(async (tx) => {
    // One dream per bot at a time: a sweep, a retry and a backup job all wait here.
    await tx.$queryRaw`SELECT id FROM bots WHERE id = ${input.botId} FOR UPDATE`;
    // A run that started while this waited for the lock is still changing the memory.
    if (
      await tx.run.findFirst({
        where: { botId: input.botId, status: { in: [...ACTIVE_RUN_STATUSES] } },
        select: { id: true },
      })
    )
      return null;
    if (
      await tx.memoryDream.findFirst({
        where: {
          botId: input.botId,
          OR: [{ status: "queued" }, { createdAt: { gte: cooldownStart } }],
        },
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
        reason: input.reason,
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
  return started;
}

/**
 * One scheduler pass: bots with something new to consolidate once they have been quiet for a
 * while, or at once when enough user messages are waiting. With nothing new, a nearly full
 * memory is tidied and each owner's day gets one review. Skips are logged by reason, never with
 * message content.
 */
export async function reconcileMemoryDreams(deps: DreamDeps): Promise<void> {
  const now = deps.now?.() ?? new Date();
  let started = 0;
  // Page by id. A bot with nothing new stays eligible, so a single fixed page would let the same
  // bots fill every pass and never reach the rest. The scan still walks past idle bots; only the
  // dreams it starts are bounded.
  for (let cursor = ""; started < MEMORY_DREAM_BATCH; ) {
    const bots = await deps.prisma.bot.findMany({
      where: {
        archivedAt: null,
        OR: [{ useOwnMemory: true }, { useSharedMemory: true }],
        thread: { isNot: null },
        runs: { none: { status: { in: [...ACTIVE_RUN_STATUSES] } } },
        id: { gt: cursor },
      },
      orderBy: { id: "asc" },
      take: MEMORY_DREAM_BATCH,
      select: {
        id: true,
        spaceId: true,
        userId: true,
        name: true,
        useOwnMemory: true,
        useSharedMemory: true,
        memoryTidiedHash: true,
        thread: { select: { id: true } },
      },
    });
    if (!bots.length) return;
    cursor = bots[bots.length - 1]!.id;
    const owners = await deps.prisma.user.findMany({
      where: { id: { in: [...new Set(bots.map((bot) => bot.userId))] } },
      select: { id: true, timezone: true },
    });
    const timezones = new Map(
      owners.map((owner) => [owner.id, validTimezoneOrUtc(owner.timezone ?? "UTC")]),
    );
    for (const bot of bots) {
      const threadId = bot.thread?.id;
      if (!threadId) continue;
      const skip = (reason: MemoryDreamSkipReason) =>
        getLogger().debug("memory.dream.skipped", { "bot.id": bot.id, reason });
      if (!bot.useOwnMemory && !bot.useSharedMemory) {
        skip("off");
        continue;
      }
      const timezone = timezones.get(bot.userId) ?? "UTC";
      const last = await deps.prisma.memoryDream.findFirst({
        where: { botId: bot.id, status: "completed" },
        orderBy: { createdAt: "desc" },
        select: { sourceSeq: true, createdAt: true },
      });
      const messages = await recentUserMessages(deps.prisma, threadId, last?.sourceSeq ?? null);
      if (messages.length) {
        // New messages are worth more than a tidy: they consolidate, and the brief merges too.
        const lastMessageAt = messages[messages.length - 1]!.createdAt;
        const quiet = now.getTime() - lastMessageAt.getTime() >= DREAM_IDLE_MS;
        const reason: MemoryDreamReason | null =
          messages.length >= DREAM_BATCH_MESSAGES ? "batch" : quiet ? "idle" : null;
        if (!reason) {
          skip("waiting");
          continue;
        }
        const source = messages[messages.length - 1]!;
        if (
          await start(deps, bot, {
            reason,
            timezone,
            threadId,
            sinceSeq: last?.sourceSeq ?? null,
            sourceMessageId: source.id,
            sourceSeq: source.seq,
            cooldownMs: DREAM_IDLE_MS,
            now,
          })
        )
          started += 1;
        if (started >= MEMORY_DREAM_BATCH) return;
        continue;
      }
      const own = bot.useOwnMemory
        ? await deps.prisma.memoryDocument.findFirst({
            where: { spaceId: bot.spaceId, scope: "bot", botId: bot.id, path: MEMORY_INDEX_PATH },
            select: { content: true },
          })
        : null;
      const ownTokens = own ? memoryTokenCount(own.content) : 0;
      const tidyDue =
        own !== null &&
        ownTokens >= MEMORY_TOKEN_CAPS.bot * MEMORY_TIDY_FULL_RATIO &&
        memoryTidiedHash(own.content) !== bot.memoryTidiedHash;
      if (tidyDue) {
        if (
          await start(deps, bot, {
            reason: "tidy",
            timezone,
            threadId,
            sinceSeq: last?.sourceSeq ?? null,
            sourceMessageId: null,
            sourceSeq: last?.sourceSeq ?? null,
            cooldownMs: MEMORY_TIDY_MIN_INTERVAL_MS,
            now,
          })
        )
          started += 1;
        if (started >= MEMORY_DREAM_BATCH) return;
        continue;
      }
      const day = localDay(now, timezone);
      if (last && localDay(last.createdAt, timezone) === day) {
        skip("already-dreamed");
        continue;
      }
      const shared = bot.useSharedMemory
        ? await deps.prisma.memoryDocument.findMany({
            where: { spaceId: bot.spaceId, scope: "user" },
            select: { content: true },
          })
        : [];
      if (ownTokens === 0 && !shared.some((document) => document.content.trim().length > 0)) {
        skip("empty");
        continue;
      }
      const midnight = zonedDateTime(`${day}T00:00`, timezone);
      if (!midnight) continue;
      if (
        await start(deps, bot, {
          reason: "review",
          timezone,
          threadId,
          sinceSeq: last?.sourceSeq ?? null,
          sourceMessageId: null,
          sourceSeq: last?.sourceSeq ?? null,
          // One review a day: any dream since the owner's midnight covers it.
          cooldownMs: now.getTime() - midnight.getTime(),
          now,
        })
      )
        started += 1;
      if (started >= MEMORY_DREAM_BATCH) return;
    }
  }
}

/** Starts one dream for a scheduled bot and logs why, never with message content. */
async function start(
  deps: DreamDeps,
  bot: {
    id: string;
    spaceId: string;
    userId: string;
    name: string;
    useOwnMemory: boolean;
    useSharedMemory: boolean;
  },
  input: {
    reason: MemoryDreamReason;
    timezone: string;
    threadId: string;
    sinceSeq: number | null;
    sourceMessageId: string | null;
    sourceSeq: number | null;
    cooldownMs: number;
    now: Date;
  },
): Promise<boolean> {
  const result = await startMemoryDream(deps, {
    botId: bot.id,
    spaceId: bot.spaceId,
    userId: bot.userId,
    botName: bot.name,
    useOwnMemory: bot.useOwnMemory,
    useSharedMemory: bot.useSharedMemory,
    ...input,
  });
  if (result === "too-soon") {
    getLogger().debug("memory.dream.skipped", { "bot.id": bot.id, reason: "too-soon" });
    return false;
  }
  getLogger().info("memory.dream.started", {
    "bot.id": bot.id,
    "space.id": bot.spaceId,
    reason: input.reason,
  });
  return true;
}

/** Settles a dream's record from the run that finished it, once. */
export async function recordMemoryDream(
  prisma: PrismaClient,
  run: { id: string; startedAt?: Date | null },
  outcome: { status: "completed" | "failed"; summary?: string; errorKind?: string },
): Promise<void> {
  const dream = await prisma.memoryDream.findUnique({
    where: { runId: run.id },
    select: { id: true, status: true, botId: true, spaceId: true },
  });
  if (dream?.status !== "queued") return;
  const revisions = await prisma.memoryRevision.findMany({
    where: { sourceRunId: run.id },
    select: {
      documentId: true,
      revision: true,
      content: true,
      document: { select: { path: true } },
    },
  });
  const changedPaths = [...new Set(revisions.map((revision) => revision.document.path))];
  const added: string[] = [];
  const archived: string[] = [];
  for (const revision of revisions) {
    const previous = await prisma.memoryRevision.findFirst({
      where: { documentId: revision.documentId, revision: { lt: revision.revision } },
      orderBy: { revision: "desc" },
      select: { content: true },
    });
    const diff = lineDiff(previous?.content ?? "", revision.content);
    added.push(...diff.added);
    archived.push(...diff.archived);
  }
  const summary = outcome.summary?.trim();
  // The notes as the dream left them: a tidy runs only after they change, so a pass that
  // changed nothing still records the hash instead of retrying every sweep.
  await prisma.$transaction(async (tx) => {
    await tx.memoryDream.update({
      where: { id: dream.id },
      data: {
        status: outcome.status,
        summary: summary ? summary.slice(0, 2_000) : null,
        changedPaths,
        added: [...new Set(added)].slice(0, MEMORY_DREAM_LINE_LIMIT),
        archived: [...new Set(archived)].slice(0, MEMORY_DREAM_LINE_LIMIT),
        errorKind: outcome.errorKind ?? null,
        startedAt: run.startedAt ?? null,
        finishedAt: new Date(),
      },
    });
    if (outcome.status !== "completed") return;
    const index = await tx.memoryDocument.findFirst({
      where: {
        spaceId: dream.spaceId,
        scope: "bot",
        botId: dream.botId,
        path: MEMORY_INDEX_PATH,
      },
      select: { content: true },
    });
    await tx.bot.update({
      where: { id: dream.botId },
      data: { memoryTidiedHash: index ? memoryTidiedHash(index.content) : null },
    });
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
  if (dream?.status !== "queued") return;
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

/**
 * Keeps the newest records per bot and deletes the hidden threads older ones ran in. A Space
 * may keep more or fewer; a Space without its own setting keeps the default.
 */
export async function pruneMemoryDreams(prisma: PrismaClient): Promise<void> {
  const stale = await prisma.$queryRaw<Array<{ id: string; threadId: string | null }>>`
    with ranked as (
      select d.id, d."threadId", row_number() over (
        partition by d."botId" order by d."createdAt" desc, d.id desc
      ) as position,
      coalesce(s."dreamRetention", ${MEMORY_DREAM_RETENTION}) as retention
      from memory_dreams d
      join spaces s on s.id = d."spaceId"
    )
    select id, "threadId" from ranked where position > retention
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
): Promise<MemoryDream[]> {
  const take = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const rows = await prisma.memoryDream.findMany({
    where: { spaceId: input.spaceId, botId: input.botId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      status: true,
      reason: true,
      summary: true,
      changedPaths: true,
      added: true,
      archived: true,
      errorKind: true,
      undoneAt: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
    },
  });
  return rows.map(toMemoryDream);
}

function toMemoryDream(row: {
  id: string;
  status: string;
  reason: string | null;
  summary: string | null;
  changedPaths: string[];
  added: string[];
  archived: string[];
  errorKind: string | null;
  undoneAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}): MemoryDream {
  return {
    id: row.id,
    status:
      row.status === "completed" ? "completed" : row.status === "failed" ? "failed" : "queued",
    reason: dreamReason(row.reason),
    summary: row.summary,
    changedPaths: row.changedPaths,
    added: row.added,
    archived: row.archived,
    errorKind: row.errorKind,
    undoneAt: row.undoneAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * A person's "dream now": the same consolidation, but it may start outside the night and skips
 * the nightly cooldown. It still refuses while the bot works, while another dream runs, and
 * while one started in the last ten minutes.
 */
export async function startManualMemoryDream(
  deps: DreamDeps,
  input: { spaceId: string; botId: string },
): Promise<MemoryDream> {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: input.botId, spaceId: input.spaceId, archivedAt: null },
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
  if (!bot) throw new ClientError("NOT_FOUND", "Bot not found.");
  if (!bot.useOwnMemory && !bot.useSharedMemory)
    throw new ClientError(
      "BAD_REQUEST",
      "Memory is off for this bot, so there is nothing to dream.",
    );
  if (!bot.thread)
    throw new ClientError("CONFLICT", "This bot has no conversation to consolidate.");
  if (
    await deps.prisma.run.findFirst({
      where: { botId: bot.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true },
    })
  )
    throw new ClientError("CONFLICT", "The bot is working. Try again when it is idle.");
  const now = deps.now?.() ?? new Date();
  const messages = await recentUserMessages(deps.prisma, bot.thread.id, null);
  const source = messages[messages.length - 1];
  const owner = await deps.prisma.user.findUnique({
    where: { id: bot.userId },
    select: { timezone: true },
  });
  const started = await startMemoryDream(deps, {
    botId: bot.id,
    spaceId: bot.spaceId,
    userId: bot.userId,
    botName: bot.name,
    reason: "manual",
    timezone: validTimezoneOrUtc(owner?.timezone ?? "UTC"),
    threadId: bot.thread.id,
    useOwnMemory: bot.useOwnMemory,
    useSharedMemory: bot.useSharedMemory,
    sinceSeq: null,
    sourceMessageId: source?.id ?? null,
    sourceSeq: source?.seq ?? null,
    cooldownMs: MANUAL_DREAM_MIN_INTERVAL_MS,
    now,
  });
  if (started === "too-soon")
    throw new ClientError("CONFLICT", "A dream ran recently. Try again in a few minutes.");
  const dream = await deps.prisma.memoryDream.findUniqueOrThrow({
    where: { id: started.dreamId },
    select: {
      id: true,
      status: true,
      reason: true,
      summary: true,
      changedPaths: true,
      added: true,
      archived: true,
      errorKind: true,
      undoneAt: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
    },
  });
  return toMemoryDream(dream);
}

/**
 * Undoes the bot's latest finished dream: every document it wrote goes back to the content it
 * held before, as a new "undo" revision, so the history still says what happened. Anything
 * written since makes the undo impossible instead of losing it.
 */
export async function undoMemoryDream(
  prisma: PrismaClient,
  input: { spaceId: string; dreamId: string },
): Promise<MemoryDream> {
  const dream = await prisma.memoryDream.findFirst({
    where: { id: input.dreamId, spaceId: input.spaceId },
    select: {
      id: true,
      status: true,
      reason: true,
      summary: true,
      changedPaths: true,
      added: true,
      archived: true,
      errorKind: true,
      createdAt: true,
      botId: true,
      runId: true,
      undoneAt: true,
    },
  });
  if (!dream) throw new ClientError("NOT_FOUND", "Dream not found.");
  if (dream.status !== "completed" || dream.undoneAt)
    throw new ClientError("CONFLICT", "Only a finished dream can be undone.");
  const latest = await prisma.memoryDream.findFirst({
    where: { botId: dream.botId, status: "completed", undoneAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (latest?.id !== dream.id)
    throw new ClientError("CONFLICT", "Only the latest dream can be undone.");
  if (!dream.runId) throw new ClientError("CONFLICT", "This dream wrote no memory.");
  const revisions = await prisma.memoryRevision.findMany({
    where: { sourceRunId: dream.runId },
    select: { documentId: true, revision: true },
  });
  if (!revisions.length)
    throw new ClientError("CONFLICT", "This dream changed nothing, so there is nothing to undo.");
  // A dream can write one document more than once. Undo checks the document's live revision
  // against the dream's last write, and restores the content from before its first.
  const writes = new Map<string, { first: number; last: number }>();
  for (const revision of revisions) {
    const write = writes.get(revision.documentId);
    if (!write)
      writes.set(revision.documentId, { first: revision.revision, last: revision.revision });
    else {
      write.first = Math.min(write.first, revision.revision);
      write.last = Math.max(write.last, revision.revision);
    }
  }
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        for (const [documentId, write] of writes) {
          const document = await tx.memoryDocument.findUnique({
            where: { id: documentId },
            select: { id: true, revision: true, spaceId: true },
          });
          // A document written since the dream cannot go back without losing that write.
          if (!document || document.spaceId !== input.spaceId || document.revision !== write.last)
            throw new ClientError("CONFLICT", "Memory changed since; nothing undone.");
          const previous = await tx.memoryRevision.findFirst({
            where: { documentId: document.id, revision: { lt: write.first } },
            orderBy: { revision: "desc" },
            select: { content: true },
          });
          if (!previous) {
            // The dream created the document, so undoing it removes the document again.
            await tx.memoryDocument.delete({ where: { id: document.id } });
            continue;
          }
          const restored = await tx.memoryDocument.update({
            where: { id: document.id },
            data: { content: previous.content, revision: document.revision + 1 },
          });
          await tx.memoryRevision.create({
            data: {
              documentId: document.id,
              revision: restored.revision,
              content: previous.content,
              sourceKind: "undo",
            },
          });
        }
        return tx.memoryDream.update({
          where: { id: dream.id },
          data: { undoneAt: new Date() },
          select: {
            id: true,
            status: true,
            reason: true,
            summary: true,
            changedPaths: true,
            added: true,
            archived: true,
            errorKind: true,
            undoneAt: true,
            startedAt: true,
            finishedAt: true,
            createdAt: true,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  ).then(toMemoryDream);
}
