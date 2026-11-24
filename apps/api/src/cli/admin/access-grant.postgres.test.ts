import { randomUUID } from "node:crypto";
import { asSystem, bootstrapUserSpace, createDb, runAsSystem } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import type { AdminContext } from "./admin-command.js";
import { parseAdminArgs } from "./commands.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const dbTests = databaseUrl ? describe : describe.skip;

dbTests("operator access grant", () => {
  it("gives the account's own organization its free months at once", async () => {
    const db = createDb(databaseUrl!);
    const prisma = asSystem(db.prisma);
    const id = randomUUID();
    const email = `${id}@example.test`;
    try {
      await prisma.user.create({ data: { id, email, name: "Fixture", emailVerified: true } });
      const { spaceId } = await bootstrapUserSpace(prisma, { id });
      const { organizationId } = await prisma.space.findUniqueOrThrow({ where: { id: spaceId } });
      await prisma.modelCreditAccount.upsert({
        where: { organizationId },
        create: { organizationId, mode: "byok" },
        update: { mode: "byok" },
      });

      const context = { prisma } as unknown as AdminContext;
      const result = await runAsSystem("test an operator access grant", () =>
        parseAdminArgs(["access", "grant", email.toUpperCase(), "3"])!.run(context),
      );

      const { byokFreeUntil } = await prisma.modelCreditAccount.findUniqueOrThrow({
        where: { organizationId },
      });
      const days = (byokFreeUntil!.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(89);
      expect(days).toBeLessThanOrEqual(90);
      expect(result.json).toMatchObject({
        organizationId,
        freeUntil: byokFreeUntil!.toISOString(),
        counting: true,
      });
    } finally {
      await prisma.accessGrant.deleteMany({ where: { email } });
      await prisma.user.deleteMany({ where: { id } });
      await prisma.$disconnect();
      await db.pool.end();
    }
  });
});
