import type { ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import {
  ComputerSizeSchema,
  SANDBOX_HOURLY_COST_MICROS,
  SANDBOX_SIZE_HOURLY_COST_MICROS,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { MICROS_PER_DOLLAR, sandboxAllowancePlan, sandboxRunHours } from "@rakazo/db";
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

/** This period's computer allowance and spend, in micro-dollars; null when it has no limit. */
export async function sandboxAllowance(
  deps: AllowanceDeps,
  organizationId: string,
  now = new Date(),
): Promise<{ limitMicros: number; usedMicros: number; resetsAt: Date | null } | null> {
  const plan = await sandboxAllowancePlan(deps.prisma, organizationId, now);
  if (plan === null) return null;
  const runs = await sandboxRunHours(deps.prisma, organizationId, plan.since, now);
  const usedMicros = runs.reduce(
    (sum, run) => sum + run.hours * sandboxHourlyCostMicros(deps.sandbox, run),
    0,
  );
  return {
    limitMicros: (plan.limitCents * MICROS_PER_DOLLAR) / 100,
    usedMicros: Math.round(usedMicros),
    resetsAt: plan.resetsAt,
  };
}

/** Whole hours, or tenths under one hour, so time that is left never reads as zero. */
export function sandboxHoursLeft(
  allowance: { limitMicros: number; usedMicros: number },
  hourMicros = SANDBOX_HOURLY_COST_MICROS,
): number {
  const hours = Math.max(0, allowance.limitMicros - allowance.usedMicros) / hourMicros;
  return hours >= 1 ? Math.floor(hours) : Math.floor(hours * 10) / 10;
}

/** Whether a computer of this kind bills and its organization spent this period's allowance. */
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
  const allowance = await sandboxAllowance(deps, space.organizationId);
  return allowance !== null && allowance.usedMicros >= allowance.limitMicros;
}
