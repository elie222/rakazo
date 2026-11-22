import type { JobPublisher } from "@rakazo/adapter-kit";
import { ACTIVE_RUN_STATUSES, computerUsingRuns, ONCE_ROUTINE_CRON } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  isUniqueViolation,
  memberHasModelAccess,
  STRATEGIC_INITIATIVE_NONCE_PREFIX,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import { modelCreditBillingEnabled } from "../runs/turn/run-model.js";
import { wakeRun } from "../runs/wakeups/wake-run.js";
import { initiativePrompt } from "./strategic-initiative.prompt.js";

const STRATEGIC_INITIATIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;
// A failed check-in usually means the bot's model setup is broken; retrying daily only repeats it.
const FAILED_CHECK_IN_BACKOFF_MS = 7 * STRATEGIC_INITIATIVE_INTERVAL_MS;
const STALE_SCRATCHPAD_ITEM_MS = 12 * 60 * 60 * 1000;
// Nobody has touched it for two weeks, so it stops counting as open.
const PARK_SCRATCHPAD_ITEM_MS = 14 * STRATEGIC_INITIATIVE_INTERVAL_MS;
const MAX_ITEMS_IN_PROMPT = 5;
const MAX_STALE_ITEMS_SCANNED = 50;
const STRATEGIC_INITIATIVE_SAFE_TOOL_NAMES = new Set(["ask_user"]);

type StrategicBot = {
  id: string;
  spaceId: string;
  userId: string;
  name: string;
  thread: { id: string } | null;
  scratchpadItems: Array<{
    title: string;
    notes: string;
    updatedAt: Date;
  }>;
};

/** A follow-up covers its item until it fires and for a day after, like a check-in. */
function pendingFollowUps(now: Date): Prisma.RoutineWhereInput {
  return {
    crons: { has: ONCE_ROUTINE_CRON },
    OR: [
      { active: true },
      { lastRunAt: { gt: new Date(now.getTime() - STRATEGIC_INITIATIVE_INTERVAL_MS) } },
    ],
  };
}

/**
 * Parks open work nobody has touched for two weeks, so the list holds what is still live.
 * Its own pass, because a busy or waiting bot is skipped by the check-in. Work a pending
 * follow-up covers stays open.
 */
export async function parkForgottenOpenWork(deps: {
  prisma: PrismaClient;
  now: Date;
  pageSize: number;
}): Promise<number> {
  const forgotten = {
    status: "open",
    updatedAt: { lte: new Date(deps.now.getTime() - PARK_SCRATCHPAD_ITEM_MS) },
  };
  const tidied = { archivedAt: null, dailyCheckIns: true, space: { deletingAt: null } };
  let parked = 0;
  let cursor: string | undefined;
  for (;;) {
    const bots = await deps.prisma.bot.findMany({
      where: {
        ...tidied,
        scratchpadItems: { some: forgotten },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: {
        id: true,
        routines: { where: pendingFollowUps(deps.now), select: { id: true } },
      },
      orderBy: { id: "asc" },
      take: deps.pageSize,
    });
    if (bots.length === 0) return parked;
    cursor = bots[bots.length - 1]!.id;
    for (const bot of bots) {
      // The age, coverage and the bot's settings are part of the write, so an item touched or a
      // bot switched off since the read is left alone.
      const { count } = await deps.prisma.scratchpadItem.updateMany({
        where: {
          botId: bot.id,
          bot: tidied,
          ...forgotten,
          ...(bot.routines.length
            ? { NOT: bot.routines.map((routine) => ({ notes: { contains: routine.id } })) }
            : {}),
        },
        data: { status: "parked" },
      });
      if (count > 0) getLogger().info("open_work.parked", { "bot.id": bot.id, count });
      parked += count;
    }
  }
}

function strategicBotEligibility(now: Date): Prisma.BotWhereInput {
  return {
    archivedAt: null,
    dailyCheckIns: true,
    space: { deletingAt: null },
    thread: { isNot: null },
    scratchpadItems: {
      some: {
        status: "open",
        updatedAt: { lte: new Date(now.getTime() - STALE_SCRATCHPAD_ITEM_MS) },
      },
    },
    runs: {
      none: {
        OR: [
          // A background helper leaves its bot free, so it does not hold off the check-in.
          { status: { in: [...ACTIVE_RUN_STATUSES] }, ...computerUsingRuns() },
          {
            clientNonce: { startsWith: `${STRATEGIC_INITIATIVE_NONCE_PREFIX}:` },
            createdAt: { gt: new Date(now.getTime() - STRATEGIC_INITIATIVE_INTERVAL_MS) },
          },
          {
            clientNonce: { startsWith: `${STRATEGIC_INITIATIVE_NONCE_PREFIX}:` },
            status: "failed",
            createdAt: { gt: new Date(now.getTime() - FAILED_CHECK_IN_BACKOFF_MS) },
          },
        ],
      },
    },
  };
}

/** Hourly cadence for the elected reconciler, including bots skipped by the sweep. */
export function createStrategicInitiativeReconciler(deps: {
  prisma: PrismaClient;
  jobs: JobPublisher;
  billingEnabled?: boolean;
  now?: () => Date;
}): () => Promise<void> {
  let lastRun: number | undefined;
  let sweeping = false;
  return async () => {
    const now = deps.now?.() ?? new Date();
    if (sweeping || (lastRun !== undefined && now.getTime() - lastRun < 60 * 60 * 1000)) return;
    sweeping = true;
    // Runs beside the reconciler pass so a large sweep never delays run recovery.
    void (async () => {
      // Parked first, so a check-in is never spent on work that has just been set aside.
      await bestEffort(
        "park forgotten open work",
        parkForgottenOpenWork({ prisma: deps.prisma, now, pageSize: 100 }),
      );
      return reconcileStrategicInitiatives({
        prisma: deps.prisma,
        jobs: deps.jobs,
        billingEnabled: await modelCreditBillingEnabled(deps),
        now,
        pageSize: 100,
      });
    })()
      .then(
        () => {
          lastRun = now.getTime();
        },
        (error) => getLogger().error("strategic initiative sweep", error),
      )
      .finally(() => {
        sweeping = false;
      });
  };
}

/**
 * Daily strategic sweep: stale open scratchpad work gets one proactive check.
 *
 * The run is a routine-trigger turn so it may choose `NO_RESPONSE` when there is
 * nothing high-signal to report, instead of posting routine noise.
 */
export async function reconcileStrategicInitiatives(deps: {
  prisma: PrismaClient;
  jobs: JobPublisher;
  now: Date;
  pageSize: number;
  billingEnabled?: boolean;
}): Promise<number> {
  const eligibleWhere = strategicBotEligibility(deps.now);
  let queued = 0;
  let cursor: string | undefined;
  for (;;) {
    const bots = await deps.prisma.bot.findMany({
      where: { ...eligibleWhere, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: {
        id: true,
        spaceId: true,
        userId: true,
        name: true,
        thread: { select: { id: true } },
        scratchpadItems: {
          where: {
            status: "open",
            updatedAt: { lte: new Date(deps.now.getTime() - STALE_SCRATCHPAD_ITEM_MS) },
          },
          select: { title: true, notes: true, updatedAt: true },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take: MAX_STALE_ITEMS_SCANNED,
        },
        routines: { where: pendingFollowUps(deps.now), select: { id: true } },
      },
      orderBy: { id: "asc" },
      take: deps.pageSize,
    });

    if (bots.length === 0) break;
    cursor = bots[bots.length - 1]!.id;
    for (const bot of bots) {
      // The free checks first, so a bot with nothing to plan costs no queries.
      if (!bot.thread) continue;
      const scratchpadItems = bot.scratchpadItems
        .filter((item) => !bot.routines.some((routine) => item.notes.includes(routine.id)))
        .slice(0, MAX_ITEMS_IN_PROMPT);
      if (scratchpadItems.length === 0) continue;
      const membership = await deps.prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: bot.spaceId, userId: bot.userId } },
        select: { id: true },
      });
      if (!membership) continue;
      // The bot's person pays: a guest's run is decided by their own plan, not the space's.
      if (deps.billingEnabled && !(await memberHasModelAccess(deps.prisma, bot))) continue;
      const runId = await queueStrategicInitiativeRun(deps, { ...bot, scratchpadItems }, deps.now);
      if (!runId) continue;
      queued += 1;
      await wakeRun(deps.jobs, runId);
    }
  }
  return queued;
}

export function isStrategicInitiativeRun(input: {
  trigger: string;
  clientNonce?: string | null;
}): boolean {
  if (input.trigger !== "routine") return false;
  const nonce = input.clientNonce?.trim();
  return Boolean(nonce?.startsWith(`${STRATEGIC_INITIATIVE_NONCE_PREFIX}:`));
}

/** Strategic sweeps are read-mostly and user-facing: no autonomous side effects. */
export function filterStrategicInitiativeTools<T extends { name: string }>(
  tools: readonly T[],
  input: { trigger: string; clientNonce: string | null | undefined },
): T[] {
  if (!isStrategicInitiativeRun(input)) return [...tools];
  return tools.filter((tool) => strategicInitiativeToolAllowed(tool.name, input));
}

/** Enforced at dispatch too: model tool declarations are not an authorization boundary. */
export function strategicInitiativeToolAllowed(
  name: string,
  run: { trigger: string; clientNonce?: string | null },
): boolean {
  return !isStrategicInitiativeRun(run) || STRATEGIC_INITIATIVE_SAFE_TOOL_NAMES.has(name);
}

function strategicInitiativeNonce(botId: string, now: Date): string {
  const bucket = Math.floor(now.getTime() / STRATEGIC_INITIATIVE_INTERVAL_MS);
  return `${STRATEGIC_INITIATIVE_NONCE_PREFIX}:${botId}:${bucket}`;
}

async function queueStrategicInitiativeRun(
  deps: { prisma: PrismaClient },
  bot: StrategicBot,
  now: Date,
): Promise<string | null> {
  const nonce = strategicInitiativeNonce(bot.id, now);
  try {
    return await deps.prisma.$transaction(async (tx) => {
      // Match the thread-before-bot lock order used by message creation. Recheck after
      // the lock so concurrent sweeps and a user starting work cannot race this claim.
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${bot.thread!.id} FOR UPDATE`;
      const eligible = await tx.bot.findFirst({
        where: {
          id: bot.id,
          ...strategicBotEligibility(now),
          space: { deletingAt: null, memberships: { some: { userId: bot.userId } } },
        },
        select: { id: true },
      });
      if (!eligible) return null;
      const existing = await tx.run.findUnique({
        where: { spaceId_clientNonce: { spaceId: bot.spaceId, clientNonce: nonce } },
        select: { id: true },
      });
      if (existing) return null;
      const task = await tx.task.create({
        data: {
          spaceId: bot.spaceId,
          botId: bot.id,
          threadId: bot.thread!.id,
          userId: bot.userId,
          prompt: initiativePrompt(bot),
          status: "queued",
        },
      });
      const run = await tx.run.create({
        data: {
          spaceId: bot.spaceId,
          botId: bot.id,
          threadId: bot.thread!.id,
          taskId: task.id,
          userId: bot.userId,
          status: "queued",
          trigger: "routine",
          clientNonce: nonce,
        },
        select: { id: true },
      });
      return run.id;
    }, THREAD_LOCK_TRANSACTION_OPTIONS);
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}
