import { randomUUID } from "node:crypto";
import { BillingEmulator } from "@rakazo/adapters";
import { BYOK_TIERS, MEDIA_ALLOWANCE_CENTS, SPEECH_ALLOWANCE_PERCENT } from "@rakazo/contracts";
import {
  allowedComputerSizes,
  asSystem,
  bootstrapUserSpace,
  COMPUTER_SIZE_PLAN_SELECT,
  createDb,
  mediaAllowancePlan,
  runAsSystem,
  sandboxAllowancePlan,
  spaceHasModelAccess,
  speechAllowancePlan,
} from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { createBillingService } from "../../billing/billing.js";
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

  it("gives the highest named tier its own expiry and plan benefits without a subscription", async () => {
    const db = createDb(databaseUrl!);
    const prisma = asSystem(db.prisma);
    const userId = randomUUID();
    const email = `${userId}@example.test`;
    try {
      await prisma.user.create({
        data: { id: userId, email, name: "Fixture", emailVerified: true },
      });
      const { spaceId } = await bootstrapUserSpace(prisma, { id: userId });
      const { organizationId } = await prisma.space.findUniqueOrThrow({ where: { id: spaceId } });
      await prisma.deploymentSettings.upsert({
        where: { id: "default" },
        create: { id: "default", modelCreditsEnabled: true },
        update: { modelCreditsEnabled: true },
      });
      const grant = (months: string, tier: string) =>
        runAsSystem("test a named own-key grant", () =>
          parseAdminArgs(["access", "grant", email, months, tier])!.run({ prisma } as AdminContext),
        );
      const max = await grant("6", "max");
      const pro = await grant("7", "pro");
      expect(max.json).toMatchObject({ organizationId, tier: "max", counting: true });
      expect(pro.json).toMatchObject({ organizationId, tier: "pro", counting: false });
      const expiry = new Date(String(max.json.freeUntil));
      expect((expiry.getTime() - Date.now()) / 86_400_000).toBeGreaterThan(179);
      expect((expiry.getTime() - Date.now()) / 86_400_000).toBeLessThanOrEqual(180);
      const provider = new BillingEmulator({ modelCredits: true, namespace: userId });
      const billing = createBillingService({ prisma, provider, webOrigin: "https://example.test" });
      await expect(
        billing.status({ userId, spaceId, email, isDeploymentOwner: false }),
      ).resolves.toMatchObject({
        access: true,
        funding: "byok",
        byokTier: "max",
        byokFreeUntil: expiry.toISOString(),
        hasCustomer: false,
      });
      await expect(spaceHasModelAccess(prisma, spaceId)).resolves.toBe(true);
      await expect(sandboxAllowancePlan(prisma, organizationId)).resolves.toMatchObject({
        limitCents: BYOK_TIERS.max.computerAllowanceCents,
      });
      await expect(speechAllowancePlan(prisma, organizationId)).resolves.toMatchObject({
        limitMicros:
          BigInt(BYOK_TIERS.max.monthlyPriceCents!) * BigInt(SPEECH_ALLOWANCE_PERCENT) * 100n,
      });
      await expect(mediaAllowancePlan(prisma, organizationId)).resolves.toMatchObject({
        limitMicros: MEDIA_ALLOWANCE_CENTS * 10_000,
      });
      const organization = await prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: COMPUTER_SIZE_PLAN_SELECT,
      });
      expect(allowedComputerSizes(organization).at(-1)).toBe(BYOK_TIERS.max.computerSize);
      expect(allowedComputerSizes(organization, expiry).at(-1)).toBe(BYOK_TIERS.pro.computerSize);
      await expect(sandboxAllowancePlan(prisma, organizationId, expiry)).resolves.toMatchObject({
        limitCents: BYOK_TIERS.pro.computerAllowanceCents,
      });
    } finally {
      await prisma.accessGrant.deleteMany({ where: { email } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
      await db.pool.end();
    }
  });
});
