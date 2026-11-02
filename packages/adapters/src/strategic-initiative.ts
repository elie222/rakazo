import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import { ACTIVE_RUN_STATUSES, truncatePlainText } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { isUniqueViolation } from "./run-messages.js";

export const STRATEGIC_INITIATIVE_NONCE_PREFIX = "strategic-initiative";
const STRATEGIC_INITIATIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STALE_SCRATCHPAD_ITEM_MS = 12 * 60 * 60 * 1000;
const MAX_ITEMS_IN_PROMPT = 5;
const MAX_NOTES_CHARS = 220;
const STRATEGIC_INITIATIVE_SAFE_TOOL_NAMES = new Set(["ask_user", "message_user"]);

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
  batchSize: number;
}): Promise<number> {
  const recentAfter = new Date(deps.now.getTime() - STRATEGIC_INITIATIVE_INTERVAL_MS);
  const staleBefore = new Date(deps.now.getTime() - STALE_SCRATCHPAD_ITEM_MS);
  const bots = await deps.prisma.bot.findMany({
    where: {
      archivedAt: null,
      thread: { isNot: null },
      scratchpadItems: { some: { status: "open", updatedAt: { lte: staleBefore } } },
      runs: { none: { status: { in: [...ACTIVE_RUN_STATUSES] } } },
      AND: [
        {
          runs: {
            none: {
              clientNonce: { startsWith: `${STRATEGIC_INITIATIVE_NONCE_PREFIX}:` },
              createdAt: { gt: recentAfter },
            },
          },
        },
      ],
    },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      name: true,
      thread: { select: { id: true } },
      scratchpadItems: {
        where: { status: "open" },
        select: { title: true, notes: true, updatedAt: true },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: MAX_ITEMS_IN_PROMPT,
      },
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: deps.batchSize,
  });

  let queued = 0;
  for (const bot of bots) {
    if (!bot.thread) continue;
    const runId = await queueStrategicInitiativeRun(deps, bot, deps.now);
    if (!runId) continue;
    queued += 1;
    await deps.jobs.enqueue(runContinueJob(runId)).catch((error) => {
      // The queued run is durable; reconciliation will repair missed wakes.
      getLogger().error("strategic initiative enqueue", error);
    });
  }
  return queued;
}

export function isStrategicInitiativeRun(input: {
  trigger: string;
  clientNonce: string | null | undefined;
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
  return tools.filter((tool) => STRATEGIC_INITIATIVE_SAFE_TOOL_NAMES.has(tool.name));
}

function strategicInitiativeNonce(botId: string, now: Date): string {
  const bucket = Math.floor(now.getTime() / STRATEGIC_INITIATIVE_INTERVAL_MS);
  return `${STRATEGIC_INITIATIVE_NONCE_PREFIX}:${botId}:${bucket}`;
}

function initiativePrompt(bot: StrategicBot): string {
  const items = bot.scratchpadItems.length
    ? bot.scratchpadItems
        .map((item, index) => {
          const note = item.notes.trim()
            ? ` — ${truncatePlainText(item.notes.trim().replace(/\s+/g, " "), MAX_NOTES_CHARS)}`
            : "";
          return `${index + 1}. ${item.title}${note}`;
        })
        .join("\n")
    : "(none)";
  return [
    `Strategic initiative sweep for ${bot.name}.`,
    "Review the stale open scratchpad work below and decide whether one proactive step is needed now.",
    "",
    "Open scratchpad items (oldest first):",
    items,
    "",
    "If no high-signal action is needed right now, the entire final reply must be exactly NO_RESPONSE.",
    "If action is needed, do only one concise proactive action: ask one blocking question or post one short update with a concrete next step.",
    "Do not repeat reminders that add no new information.",
  ].join("\n");
}

async function queueStrategicInitiativeRun(
  deps: { prisma: PrismaClient },
  bot: StrategicBot,
  now: Date,
): Promise<string | null> {
  const nonce = strategicInitiativeNonce(bot.id, now);
  try {
    return await deps.prisma.$transaction(async (tx) => {
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
    });
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}
