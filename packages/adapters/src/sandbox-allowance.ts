import type { ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  MICROS_PER_DOLLAR,
  sandboxAllowanceCents,
  sandboxAllowancePeriodStart,
  sandboxRunHours,
} from "@rakazo/db";

/**
 * What an hour of a billed computer counts against the allowance, $0.20, unless its provider
 * declares its own price through `hourlyCostMicros`: above a small cloud machine's raw price,
 * so the allowance also covers storage and saves, and a $5 allowance is about 25 hours.
 */
export const DEFAULT_SANDBOX_HOURLY_COST_MICROS = 200_000;

type AllowanceDeps = { prisma: PrismaClient; sandbox: SandboxProvider };

/** Host computers run on the user's own machine and cost nothing. */
export function sandboxHourlyCostMicros(
  sandbox: SandboxProvider,
  computer: Pick<ComputerRef, "kind">,
): number {
  if (computer.kind === "desktop") return 0;
  return (
    sandbox.hourlyCostMicros?.(computer) ??
    (sandbox.billsWhileRunning?.(computer) ? DEFAULT_SANDBOX_HOURLY_COST_MICROS : 0)
  );
}

/** This month's computer allowance and spend, in micro-dollars; null when it has no limit. */
export async function sandboxAllowance(
  deps: AllowanceDeps,
  organizationId: string,
  now = new Date(),
): Promise<{ limitMicros: number; usedMicros: number } | null> {
  const limitCents = await sandboxAllowanceCents(deps.prisma, organizationId);
  if (limitCents === null) return null;
  const runs = await sandboxRunHours(
    deps.prisma,
    organizationId,
    sandboxAllowancePeriodStart(now),
    now,
  );
  const usedMicros = runs.reduce(
    (sum, run) =>
      sum +
      run.hours * sandboxHourlyCostMicros(deps.sandbox, { kind: run.kind as ComputerRef["kind"] }),
    0,
  );
  return {
    limitMicros: (limitCents * MICROS_PER_DOLLAR) / 100,
    usedMicros: Math.round(usedMicros),
  };
}

/** Whether a computer of this kind bills and its organization spent this month's allowance. */
export async function sandboxAllowanceUsedUp(
  deps: AllowanceDeps,
  computer: { spaceId: string; kind: string },
): Promise<boolean> {
  if (sandboxHourlyCostMicros(deps.sandbox, { kind: computer.kind as ComputerRef["kind"] }) === 0)
    return false;
  const space = await deps.prisma.space.findUnique({
    where: { id: computer.spaceId },
    select: { organizationId: true },
  });
  if (!space) return false;
  const allowance = await sandboxAllowance(deps, space.organizationId);
  return allowance !== null && allowance.usedMicros >= allowance.limitMicros;
}
