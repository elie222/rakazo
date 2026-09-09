import type { ComputerMode } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";

export type { ComputerMode } from "@rakazo/contracts";

export function parseComputerMode(scope: string): ComputerMode {
  if (scope === "team" || scope === "dedicated") return scope;
  throw new Error(`Unknown computer scope: ${scope}`);
}

export function computerScopeKey(mode: ComputerMode, spaceId: string, botId?: string) {
  if (mode === "team") return `team:${spaceId}`;
  if (!botId) throw new Error("Dedicated computers require a bot id");
  return `bot:${botId}`;
}

export function computerHomeKey(mode: ComputerMode, spaceId: string, botId?: string) {
  if (mode === "team") return `team-${spaceId}`;
  if (!botId) throw new Error("Dedicated computers require a bot id");
  return botId;
}

type ComputerDb = Pick<PrismaClient, "computer">;
type ExecutionLeaseDb = Pick<PrismaClient, "computerExecutionLease">;

/**
 * Per-user ceiling on Computer records that still back a live bot, or 0 when unset.
 *
 * Each Computer row becomes a sandbox container once provisioned, so an unbounded
 * record count means an unbounded container fleet for one user. A team computer is
 * one row per space shared by its bots and counts once, not per bot.
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

/** Computers a user still backs with a live (non-archived) bot. */
async function countInUseComputersForUser(
  prisma: ComputerDb,
  userId: string,
): Promise<number> {
  return prisma.computer.count({
    where: {
      userId,
      bots: { some: { archivedAt: null } },
    },
  });
}

/**
 * Refuse a restore that would push a user past the cap.
 *
 * A restore re-links the bot to its Computer row, which reactivates the quota
 * if that row was only referenced by archived bots (the dedicated case; a team
 * row shared with live bots keeps counting). Throws ComputerLimitError when the
 * restore would exceed the configured SANDBOX_MAX_COMPUTERS_PER_USER.
 */
export async function assertComputerQuotaForRestore(
  prisma: ComputerDb,
  input: { userId: string; computerId: string },
): Promise<void> {
  const limit = resolveMaxComputersPerUser();
  if (limit <= 0) return;
  // If another live bot already references this row (team computer shared
  // across the space), restoring this bot adds nothing to the count.
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

export async function ensureComputerRecord(
  prisma: ComputerDb,
  input: {
    mode: ComputerMode;
    spaceId: string;
    userId: string;
    botId?: string;
    kind: string;
  },
) {
  const limit = resolveMaxComputersPerUser();
  if (limit > 0) {
    // Only a new row consumes quota: the upsert below reuses the existing team
    // computer on every bot created in that space, and reusing it with the count
    // already at the cap would wrongly refuse a second bot on a shared computer.
    const existing = await prisma.computer.findUnique({
      where: { scopeKey: computerScopeKey(input.mode, input.spaceId, input.botId) },
      select: { id: true },
    });
    // Archiving a bot keeps its Computer row (stopped) but releases the sandbox,
    // so archived rows must not consume quota; count only rows still referenced
    // by a non-archived bot the user owns.
    const inUse = await prisma.computer.count({
      where: {
        userId: input.userId,
        bots: { some: { archivedAt: null } },
      },
    });
    if (!existing && inUse >= limit) throw new ComputerLimitError(limit);
  }
  const scopeKey = computerScopeKey(input.mode, input.spaceId, input.botId);
  return prisma.computer.upsert({
    where: { scopeKey },
    create: {
      spaceId: input.spaceId,
      userId: input.userId,
      scope: input.mode,
      scopeKey,
      homeKey: computerHomeKey(input.mode, input.spaceId, input.botId),
      kind: input.kind,
    },
    update: {},
  });
}
