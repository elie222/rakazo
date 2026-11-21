import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const dbTests = databaseUrl ? describe : describe.skip;
dbTests("operator computer allowance command", { timeout: 120_000 }, () => {
  let db: ReturnType<typeof createDb>;
  beforeAll(() => {
    db = createDb(databaseUrl!);
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  const command = (...args: string[]) =>
    run(process.execPath, ["--import", "tsx", "apps/api/src/cli/computer-allowance.ts", ...args], {
      env: process.env,
    });

  it("adds extra dollars to the organization's current allowance", async () => {
    const prisma = asSystem(db.prisma);
    const organizationId = randomUUID();
    await prisma.organization.create({
      data: { id: organizationId, name: "Fixture", slug: organizationId, createdAt: new Date() },
    });
    const settings = await prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { modelCreditsEnabled: true },
    });
    await prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", modelCreditsEnabled: true },
      update: { modelCreditsEnabled: true },
    });
    try {
      const { stdout } = await command("grant", organizationId, "12.50");
      expect(stdout).toContain("(extra granted: $12.50)");
      expect((await command("status", organizationId)).stdout).toContain("(extra granted: $12.50)");
    } finally {
      await prisma.organization.delete({ where: { id: organizationId } });
      if (settings)
        await prisma.deploymentSettings.update({ where: { id: "default" }, data: settings });
      else await prisma.deploymentSettings.delete({ where: { id: "default" } });
    }
  });

  it("rejects invalid amounts and accidental extra arguments", async () => {
    for (const args of [
      ["grant", "organization", "-2"],
      ["grant", "organization", "0"],
      ["grant", "organization", "1.234"],
      ["grant", "organization", "10000.01"],
      ["status", "organization", "2"],
    ]) {
      await expect(command(...args)).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining("Usage:"),
      });
    }
  });
});
