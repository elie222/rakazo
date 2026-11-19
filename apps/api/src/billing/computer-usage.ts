import type { SandboxProvider } from "@rakazo/adapter-kit";
import { sandboxDisplayedHourMicros, sandboxHourlyCostMicros } from "@rakazo/adapters";
import type { ComputerSize } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { computerSizeSettings, sandboxAllowancePlan, sandboxRunHoursByComputer } from "@rakazo/db";

export async function saveComputerSize(
  prisma: PrismaClient,
  organizationId: string,
  size: ComputerSize,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Billing sync locks this row before it clears a size the new plan cannot use.
    await tx.$queryRaw`SELECT "organizationId" FROM "billing_accounts"
      WHERE "organizationId" = ${organizationId} FOR SHARE`;
    const current = await tx.organization.findUnique({
      where: { id: organizationId },
      select: {
        computerSize: true,
        modelCredits: { select: { mode: true } },
        billing: { select: { status: true, byokTier: true, byokPriceCents: true } },
      },
    });
    if (!current || !computerSizeSettings(current).available.includes(size))
      throw new ClientError("BAD_REQUEST", "Your plan does not include this computer size");
    await tx.organization.update({ where: { id: organizationId }, data: { computerSize: size } });
  });
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
