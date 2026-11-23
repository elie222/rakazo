import type { ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import {
  ComputerSizeSchema,
  SANDBOX_HOURLY_COST_MICROS,
  SANDBOX_SIZE_HOURLY_COST_MICROS,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  includedUsageChargedMicros,
  includedUsagePlan,
  MICROS_PER_DOLLAR,
  sandboxRunHours,
} from "@rakazo/db";
import { sandboxKindCapabilities } from "./sandbox-kind-capabilities.js";

type AllowanceDeps = { prisma: PrismaClient; sandbox: SandboxProvider };

/** Host computers run on the user's own machine and cost nothing. */
export function sandboxHourlyCostMicros(
  sandbox: SandboxProvider,
  computer: Pick<ComputerRef, "kind"> & { size?: string | null },
): number {
  if (sandboxKindCapabilities(computer.kind).runsOnUserMachine) return 0;
  if (!sandbox.billsWhileRunning?.(computer)) return 0;
  const size = ComputerSizeSchema.safeParse(computer.size).data;
  return size ? SANDBOX_SIZE_HOURLY_COST_MICROS[size] : SANDBOX_HOURLY_COST_MICROS;
}

/** Standard-hour equivalents keep the allowance and its breakdown in the same units. */
export function sandboxDisplayedHourMicros(sandbox: SandboxProvider): number {
  return sandboxKindCapabilities(sandbox.describe().id).sizedUsage
    ? SANDBOX_SIZE_HOURLY_COST_MICROS.standard
    : SANDBOX_HOURLY_COST_MICROS;
}

/**
 * This period's included usage and what computers and hosted media spent of it, in micro-dollars;
 * null when nothing is metered.
 */
export async function includedUsage(
  deps: Pick<AllowanceDeps, "prisma"> & { sandbox?: SandboxProvider },
  organizationId: string,
  now = new Date(),
): Promise<{
  limitMicros: number;
  usedMicros: number;
  resetsAt: Date | null;
  since: Date;
  trial: boolean;
} | null> {
  const plan = await includedUsagePlan(deps.prisma, organizationId, now);
  if (plan === null) return null;
  const [runs, chargedMicros] = await Promise.all([
    sandboxRunHours(deps.prisma, organizationId, plan.since, now),
    includedUsageChargedMicros(deps.prisma, organizationId, plan.since),
  ]);
  const { sandbox } = deps;
  const computerMicros = sandbox
    ? runs.reduce((sum, run) => sum + run.hours * sandboxHourlyCostMicros(sandbox, run), 0)
    : 0;
  return {
    limitMicros: (plan.limitCents * MICROS_PER_DOLLAR) / 100,
    usedMicros: Math.round(computerMicros) + chargedMicros,
    resetsAt: plan.resetsAt,
    since: plan.since,
    trial: plan.trial,
  };
}

/** Whole cents left, rounded down so a balance never reads as more than it is. */
export function includedUsageLeftCents(usage: { limitMicros: number; usedMicros: number }) {
  return Math.floor((Math.max(0, usage.limitMicros - usage.usedMicros) * 100) / MICROS_PER_DOLLAR);
}

/** Whole hours, or tenths under one hour, so time that is left never reads as zero. */
export function sandboxHoursLeft(
  allowance: { limitMicros: number; usedMicros: number },
  hourMicros = SANDBOX_HOURLY_COST_MICROS,
): number {
  const hours = Math.max(0, allowance.limitMicros - allowance.usedMicros) / hourMicros;
  return hours >= 1 ? Math.floor(hours) : Math.floor(hours * 10) / 10;
}

/** Whether a computer of this kind bills and its organization spent this period's included usage. */
export async function sandboxAllowanceUsedUp(
  deps: AllowanceDeps,
  computer: { spaceId: string; kind: string },
): Promise<boolean> {
  if (sandboxHourlyCostMicros(deps.sandbox, { kind: computer.kind }) === 0) return false;
  const space = await deps.prisma.space.findUnique({
    where: { id: computer.spaceId },
    select: { organizationId: true },
  });
  if (!space) return false;
  const allowance = await includedUsage(deps, space.organizationId);
  return allowance !== null && allowance.usedMicros >= allowance.limitMicros;
}
