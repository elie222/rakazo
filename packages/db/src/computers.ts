import { createHash } from "node:crypto";
import type { ComputerMode } from "@rakazo/contracts";
import { isTerminal } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { runAsSystem, runAsSystemInTransaction } from "./row-security.js";
import { withTransactionRetry } from "./transaction-retry.js";

export type { ComputerMode } from "@rakazo/contracts";

export function parseComputerMode(scope: string): ComputerMode {
  if (scope === "team" || scope === "dedicated") return scope;
  throw new Error(`Unknown computer scope: ${scope}`);
}

export type ComputerKeyInput = {
  mode: ComputerMode;
  spaceId: string;
  /** The bot owner's user id. A team computer is shared only by one user's bots in a space. */
  userId: string;
  botId?: string;
};

export function computerScopeKey(input: ComputerKeyInput) {
  if (input.mode === "team") return `team:${input.spaceId}:${input.userId}`;
  if (!input.botId) throw new Error("Dedicated computers require a bot id");
  return `bot:${input.botId}`;
}

/**
 * Sandbox providers receive the home key as the computer's bot id, and the Docker supervisor
 * keeps only its first 40 characters in container names, so a team key is a fixed-length
 * digest that stays distinct per space and user. Migration 20261021000000 computes the same
 * value in SQL. Team computers created before the per-user split keep `team-<spaceId>`.
 */
export function computerHomeKey(input: ComputerKeyInput) {
  if (input.mode === "team") {
    const digest = createHash("sha256")
      .update(`${input.spaceId}:${input.userId}`)
      .digest("hex")
      .slice(0, 32);
    return `team-${digest}`;
  }
  if (!input.botId) throw new Error("Dedicated computers require a bot id");
  return input.botId;
}

/** The home of a space's one Team Computer from before each person got their own. */
export function legacyTeamHomeKey(spaceId: string) {
  return `team-${spaceId}`;
}

type ComputerDb = Pick<PrismaClient, "computer">;
type ComputerTx = Pick<Prisma.TransactionClient, "computer" | "$queryRaw">;
type ComputerClient = ComputerDb & Partial<Pick<PrismaClient, "$transaction" | "$queryRaw">>;
type RestoreTx = ComputerTx & Pick<Prisma.TransactionClient, "bot">;
type RestoreClient = ComputerClient & Pick<PrismaClient, "bot">;
type ExecutionLeaseDb = Pick<PrismaClient, "computerExecutionLease">;

/**
 * Per-user ceiling on Computer records that still back a live bot, or 0 when unset.
 *
 * Each Computer row becomes a sandbox container once provisioned, so an unbounded
 * record count means an unbounded container fleet for one user. A team computer is
 * one row per space and user, shared by that user's bots there, and counts once, not per bot.
 */
export function resolveMaxComputersPerUser(
  value = process.env.SANDBOX_MAX_COMPUTERS_PER_USER,
): number {
  if (value === undefined || value.trim() === "" || value.trim() === "0") return 0;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(
      "SANDBOX_MAX_COMPUTERS_PER_USER must be a positive integer, or 0 for no configured cap",
    );
  }
  return limit;
}

export class ComputerLimitError extends Error {
  constructor(limit: number) {
    super(`User computer limit (${limit}) reached`);
    this.name = "ComputerLimitError";
  }
}

/**
 * Computers a user still backs with a live (non-archived) bot.
 *
 * excludeBotId drops one bot's current reference: a bot being re-linked to a
 * new computer in the same transaction leaves its old row behind, so that
 * intermediate reference must not count against the final live set.
 */
async function countInUseComputersForUser(
  prisma: ComputerDb & Partial<Pick<PrismaClient, "$queryRaw">>,
  userId: string,
  excludeBotId?: string,
): Promise<number> {
  const count = () =>
    prisma.computer.count({
      where: {
        userId,
        bots: {
          some: excludeBotId
            ? { archivedAt: null, id: { not: excludeBotId } }
            : { archivedAt: null },
        },
      },
    });
  // The quota is per person, so it counts the computers of all their Spaces.
  const reason = "computer quota across the user's Spaces";
  return prisma.$queryRaw
    ? runAsSystemInTransaction(prisma as Pick<PrismaClient, "$queryRaw">, reason, count)
    : runAsSystem(reason, count);
}

/**
 * Serialize existence check + in-use count + Computer create for one user.
 * Seed 1 keeps this keyspace apart from lockSpaceForContentCreation (seed 0).
 */
async function lockUserForComputerQuota(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  userId: string,
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 1))::text AS "lock"
  `);
}

/**
 * A restore re-links the bot to its Computer row, which reactivates the quota
 * if that row was only referenced by archived bots (the dedicated case; a team
 * row shared with live bots keeps counting).
 */
export async function assertComputerQuotaForRestore(
  prisma: ComputerDb,
  input: { userId: string; computerId: string },
): Promise<void> {
  const limit = resolveMaxComputersPerUser();
  if (limit <= 0) return;
  // If another live bot already references this row (a team computer shared
  // by the user's bots in the space), restoring this bot adds nothing to the count.
  const alreadyLive = await prisma.computer.count({
    where: {
      id: input.computerId,
      bots: { some: { archivedAt: null } },
    },
  });
  if (alreadyLive > 0) return;
  const inUse = await countInUseComputersForUser(prisma, input.userId);
  if (inUse >= limit) throw new ComputerLimitError(limit);
}

/**
 * Unarchive a bot while holding the same per-user quota lock as create.
 *
 * Concurrent restores of archived bots on distinct computers can both pass an
 * unlocked count when one slot remains; the lock covers count + archivedAt
 * clear so only one of those restores can consume the last slot.
 */
export async function restoreBotUnderComputerQuota(
  prisma: RestoreClient,
  input: { userId: string; botId: string; computerId: string },
): Promise<void> {
  const limit = resolveMaxComputersPerUser();

  async function restore(tx: RestoreTx) {
    if (limit > 0) {
      await lockUserForComputerQuota(tx, input.userId);
      await assertComputerQuotaForRestore(tx, input);
    }
    await tx.bot.update({ where: { id: input.botId }, data: { archivedAt: null } });
  }

  if (isTransactionClient(prisma)) {
    return restore(prisma as RestoreTx);
  }
  if (limit <= 0) {
    await prisma.bot.update({ where: { id: input.botId }, data: { archivedAt: null } });
    return;
  }
  if (typeof prisma.$transaction === "function") {
    return withTransactionRetry(() => prisma.$transaction!((tx) => restore(tx)));
  }
  throw new Error("Computer quota enforcement requires a Prisma transaction");
}

/** Expire leases as fencing tombstones so the next acquire increments fence. */
export async function expireComputerExecutionLeases(
  prisma: ExecutionLeaseDb,
  where: Prisma.ComputerExecutionLeaseWhereInput,
): Promise<void> {
  await prisma.computerExecutionLease.updateMany({
    where,
    data: { expiresAt: new Date(0) },
  });
}

type ExecutionBindingDb = Pick<PrismaClient, "computer" | "run">;

/**
 * Clear a legacy execution binding whose run can no longer execute. Pre-lease releases
 * wrote Computer.executionRunId and only the run's own teardown cleared it, so a
 * binding stranded by a missed cleanup blocks computer suspension forever: suspension
 * requires a null binding. Bindings to runs that may still execute are left alone.
 */
export async function clearEndedExecutionRunBinding(
  prisma: ExecutionBindingDb,
  computerId: string,
): Promise<void> {
  const binding = await prisma.computer.findUnique({
    where: { id: computerId },
    select: { executionRunId: true },
  });
  const runId = binding?.executionRunId;
  if (!runId) return;
  const run = await prisma.run.findUnique({ where: { id: runId }, select: { status: true } });
  if (run && !isTerminal(run.status)) return;
  await prisma.computer.updateMany({
    where: { id: computerId, executionRunId: runId },
    data: { executionRunId: null, executionBotId: null, executionLeaseExpiresAt: null },
  });
}

function upsertComputerRecord(
  prisma: ComputerDb,
  input: {
    mode: ComputerMode;
    spaceId: string;
    userId: string;
    botId?: string;
    kind: string;
  },
  scopeKey: string,
) {
  return prisma.computer.upsert({
    where: { scopeKey },
    create: {
      spaceId: input.spaceId,
      userId: input.userId,
      scope: input.mode,
      scopeKey,
      homeKey: computerHomeKey(input),
      kind: input.kind,
    },
    update: {},
  });
}

async function ensureComputerRecordWithQuota(
  tx: ComputerTx,
  input: {
    mode: ComputerMode;
    spaceId: string;
    userId: string;
    botId?: string;
    kind: string;
  },
  limit: number,
  scopeKey: string,
) {
  await lockUserForComputerQuota(tx, input.userId);
  // Only a new row consumes quota: the upsert below reuses the user's team
  // computer on every bot they create in that space, and reusing it with the count
  // already at the cap would wrongly refuse a second bot on a shared computer.
  const existing = await tx.computer.findUnique({
    where: { scopeKey },
    select: { id: true },
  });
  if (!existing) {
    // This bot's current reference leaves the live set when this link commits
    // (createBot links the team computer first, then re-links the bot to the new
    // dedicated one; setBotComputer switches the same way), so exclude it or a
    // transaction ending with exactly one active computer is refused at cap 1.
    const inUse = await countInUseComputersForUser(tx, input.userId, input.botId);
    // The new row itself will be referenced by this bot after the link, so
    // the post-transaction set is one more than the remaining live set.
    if (inUse + 1 > limit) throw new ComputerLimitError(limit);
  }
  return upsertComputerRecord(tx, input, scopeKey);
}

function isTransactionClient(prisma: ComputerClient): prisma is ComputerTx {
  return typeof prisma.$queryRaw === "function" && typeof prisma.$transaction !== "function";
}

export async function ensureComputerRecord(
  prisma: ComputerClient,
  input: {
    mode: ComputerMode;
    spaceId: string;
    userId: string;
    botId?: string;
    kind: string;
  },
) {
  const limit = resolveMaxComputersPerUser();
  const scopeKey = computerScopeKey(input);
  if (limit <= 0) return upsertComputerRecord(prisma, input, scopeKey);

  // Cap is set: hold a per-user advisory lock across find + count + create so
  // concurrent creates for different spaces cannot both pass the check.
  if (isTransactionClient(prisma)) {
    return ensureComputerRecordWithQuota(prisma, input, limit, scopeKey);
  }
  if (typeof prisma.$transaction === "function") {
    return withTransactionRetry(() =>
      prisma.$transaction!((tx) => ensureComputerRecordWithQuota(tx, input, limit, scopeKey)),
    );
  }
  throw new Error("Computer quota enforcement requires a Prisma transaction");
}
