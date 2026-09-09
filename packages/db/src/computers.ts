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
