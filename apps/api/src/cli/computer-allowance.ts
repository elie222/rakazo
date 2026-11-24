// Operator control: computer-allowance.js grant <organization-id> <extra-usd> | status <organization-id>
import { contentKeyProviderFromEnv, unwrapEnvFromKeyManager } from "@rakazo/adapters";
import { createDb, grantComputerAllowance, runAsSystem, sandboxAllowancePlan } from "@rakazo/db";
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
    let plan = await sandboxAllowancePlan(prisma, organizationId, new Date());
    if (!plan) {
      process.stdout.write("Computers are not limited on this deployment.\n");
      return;
    }
    if (action === "grant") {
      await grantComputerAllowance(prisma, organizationId, amountCents!);
      plan = (await sandboxAllowancePlan(prisma, organizationId, new Date()))!;
    }
    // Hours left are what Billing shows; it prices runs with the provider, which this cannot.
    const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
    process.stdout.write(
      `Allowance this period: ${usd(plan.limitCents)} (extra granted: ${usd(plan.extraCents)})\nPeriod began: ${plan.since.toISOString()}\nResets: ${plan.resetsAt?.toISOString() ?? "no scheduled reset"}\n`,
    );
  });
} finally {
  await prisma.$disconnect();
  await pool.end();
}
