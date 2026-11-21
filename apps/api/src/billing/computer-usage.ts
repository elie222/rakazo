import type { SandboxProvider } from "@rakazo/adapter-kit";
import {
  sandboxDisplayedHourMicros,
  sandboxHourlyCostMicros,
  sandboxKindsWhere,
} from "@rakazo/adapters";
import type { CloudComputers, ComputerSize } from "@rakazo/contracts";
import { ComputerSizeSchema } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  allowedComputerSizes,
  COMPUTER_SIZE_PLAN_SELECT,
  effectiveComputerSize,
  sandboxAllowancePlan,
  sandboxRunHoursByComputer,
} from "@rakazo/db";

const sizedKinds = () => sandboxKindsWhere((capabilities) => capabilities.sizedUsage === true);

async function planSizes(prisma: PrismaClient, organizationId: string) {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: COMPUTER_SIZE_PLAN_SELECT,
  });
  return allowedComputerSizes(organization);
}

/** The Space's sized computers; a private one shows only while its bot does. */
export async function readCloudComputers(
  prisma: PrismaClient,
  organizationId: string,
  spaceId: string,
  canManage: boolean,
): Promise<CloudComputers> {
  const [available, computers] = await Promise.all([
    planSizes(prisma, organizationId),
    prisma.computer.findMany({
      where: { spaceId, space: { organizationId }, kind: { in: sizedKinds() } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        scope: true,
        size: true,
        bots: {
          where: { archivedAt: null },
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { name: true },
        },
      },
    }),
  ]);
  return {
    computers: computers.flatMap(({ id, scope, size, bots }): CloudComputers["computers"] => {
      const shown = {
        id,
        size: effectiveComputerSize(size, available),
        savedSize: ComputerSizeSchema.catch("standard").parse(size),
      };
      if (scope !== "dedicated") return [{ ...shown, scope: "team" as const, botName: null }];
      const botName = bots[0]?.name;
      return botName ? [{ ...shown, scope: "dedicated" as const, botName }] : [];
    }),
    available,
    canManage,
  };
}

export async function saveCloudComputerSize(
  prisma: PrismaClient,
  organizationId: string,
  spaceId: string,
  computerId: string,
  size: ComputerSize,
): Promise<void> {
  if (!(await planSizes(prisma, organizationId)).includes(size))
    throw new ClientError("BAD_REQUEST", "Your plan does not include this computer size");
  const { count } = await prisma.computer.updateMany({
    where: { id: computerId, spaceId, space: { organizationId }, kind: { in: sizedKinds() } },
    data: { size },
  });
  if (count === 0) throw new ClientError("NOT_FOUND", "Computer not found");
}

export async function readComputerUsage(
  prisma: PrismaClient,
  sandbox: SandboxProvider,
  organizationId: string,
  spaceId: string,
) {
  const now = new Date();
  const plan = await sandboxAllowancePlan(prisma, organizationId, now);
  if (!plan) return { computers: [], otherHours: 0 };

  const runs = await sandboxRunHoursByComputer(prisma, organizationId, plan.since, now);
  const hoursByComputer = new Map<string, number>();
  const unit = sandboxDisplayedHourMicros(sandbox);
  for (const run of runs) {
    const { computerId, hours } = run;
    const used = (hours * sandboxHourlyCostMicros(sandbox, run)) / unit;
    if (used > 0) hoursByComputer.set(computerId, (hoursByComputer.get(computerId) ?? 0) + used);
  }
  const visible = await prisma.computer.findMany({
    where: { id: { in: [...hoursByComputer.keys()] }, spaceId },
    select: {
      id: true,
      scope: true,
      bots: {
        where: { archivedAt: null },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { name: true },
      },
    },
  });
  const computers = visible.map(({ id, scope, bots }) => {
    const hours = hoursByComputer.get(id) ?? 0;
    hoursByComputer.delete(id);
    return scope === "dedicated"
      ? { id, scope: "dedicated" as const, botName: bots[0]?.name ?? null, hours }
      : { id, scope: "team" as const, botName: null, hours };
  });
  // The allowance spans the organization. Only name computers in the current Space.
  return {
    computers: computers.sort((a, b) => b.hours - a.hours),
    otherHours: [...hoursByComputer.values()].reduce((sum, hours) => sum + hours, 0),
  };
}
