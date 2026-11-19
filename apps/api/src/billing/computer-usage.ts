import type { SandboxProvider } from "@rakazo/adapter-kit";
import { sandboxHourlyCostMicros } from "@rakazo/adapters";
import { SANDBOX_HOURLY_COST_MICROS } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { sandboxAllowancePlan, sandboxRunHoursByComputer } from "@rakazo/db";

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
  for (const { computerId, hours, kind } of runs) {
    const used = (hours * sandboxHourlyCostMicros(sandbox, { kind })) / SANDBOX_HOURLY_COST_MICROS;
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
