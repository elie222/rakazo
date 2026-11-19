// Operator control: computer-allowance.js grant <organization-id> <extra-usd> | status <organization-id>
import {
  contentKeyProviderFromEnv,
  sandboxHoursLeft,
  sandboxKindCapabilities,
  unwrapEnvFromKeyManager,
} from "@rakazo/adapters";
import {
  ComputerSizeSchema,
  SANDBOX_HOURLY_COST_MICROS,
  SANDBOX_SIZE_HOURLY_COST_MICROS,
} from "@rakazo/contracts";
import {
  createDb,
  grantComputerAllowance,
  MICROS_PER_DOLLAR,
  runAsSystem,
  sandboxAllowancePlan,
  sandboxRunHours,
} from "@rakazo/db";
import { loadEnv } from "../env.js";

const [action, organizationId, dollars, ...extra] = process.argv.slice(2);
const amountCents =
  dollars !== undefined && /^(?:0|[1-9]\d{0,4})(?:\.\d{1,2})?$/.test(dollars)
    ? Math.round(Number(dollars) * 100)
    : null;
if (
  !organizationId ||
  extra.length ||
  (action !== "grant" && action !== "status") ||
  (action === "grant"
    ? amountCents === null || amountCents <= 0 || amountCents > 1_000_000
    : dollars !== undefined)
) {
  process.stderr.write(
    "Usage: computer-allowance.js grant <organization-id> <extra-usd> | status <organization-id>\n",
  );
  process.exit(2);
}

await unwrapEnvFromKeyManager();
const env = loadEnv();
const { prisma, pool } = createDb(env.databaseUrl, { keyProvider: contentKeyProviderFromEnv() });
try {
  await runAsSystem("manage an organization's computer allowance", async () => {
    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!organization) throw new Error("No organization has that id");
    let now = new Date();
    let plan = await sandboxAllowancePlan(prisma, organizationId, now);
    if (!plan) {
      process.stdout.write("Computers are not limited on this deployment.\n");
      return;
    }
    if (action === "grant") {
      await grantComputerAllowance(prisma, organizationId, amountCents!);
      now = new Date();
      plan = (await sandboxAllowancePlan(prisma, organizationId, now))!;
    }
    // Counts every run off the user's own machine; providers that do not bill may count less.
    const runs = await sandboxRunHours(prisma, organizationId, plan.since, now);
    const usedMicros = runs.reduce((sum, run) => {
      if (sandboxKindCapabilities(run.kind).runsOnUserMachine) return sum;
      const size = ComputerSizeSchema.safeParse(run.size).data;
      return (
        sum +
        run.hours * (size ? SANDBOX_SIZE_HOURLY_COST_MICROS[size] : SANDBOX_HOURLY_COST_MICROS)
      );
    }, 0);
    const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
    const hoursLeft = sandboxHoursLeft(
      { limitMicros: (plan.limitCents * MICROS_PER_DOLLAR) / 100, usedMicros },
      SANDBOX_SIZE_HOURLY_COST_MICROS.standard,
    );
    process.stdout.write(
      `Allowance this period: ${usd(plan.limitCents)} (extra granted: ${usd(plan.extraCents)})\nPeriod began: ${plan.since.toISOString()}\nResets: ${plan.resetsAt?.toISOString() ?? "no scheduled reset"}\nStandard computer hours left: ${hoursLeft}\n`,
    );
  });
} finally {
  await prisma.$disconnect();
  await pool.end();
}
