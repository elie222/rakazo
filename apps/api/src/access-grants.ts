import { ORPCError } from "@orpc/server";
import type { AccessGrant, AccessGrantInput } from "@rakazo/contracts";
import { AccessGrantInputSchema } from "@rakazo/contracts";
import type { AccessGrant as AccessGrantRow, PrismaClient } from "@rakazo/db";
import { extendByokFreePeriod, FREE_MONTH_DAYS, reconcileCreditPurchase } from "@rakazo/db";

const LIST_LIMIT = 200;

function accessGrantDto(row: AccessGrantRow): AccessGrant {
  return {
    id: row.id,
    email: row.email,
    creditCents: row.creditCents,
    freeMonths: row.freeMonths,
    createdBy: row.createdBy,
    status: row.revokedAt ? "revoked" : row.appliedAt ? "applied" : "pending",
    createdAt: row.createdAt.toISOString(),
    appliedAt: row.appliedAt?.toISOString() ?? null,
  };
}

export async function listAccessGrants(prisma: PrismaClient): Promise<AccessGrant[]> {
  const rows = await prisma.accessGrant.findMany({
    orderBy: { createdAt: "desc" },
    take: LIST_LIMIT,
  });
  return rows.map(accessGrantDto);
}

export async function createAccessGrant(
  prisma: PrismaClient,
  createdBy: string,
  input: AccessGrantInput,
): Promise<AccessGrant> {
  const data = AccessGrantInputSchema.parse(input);
  return accessGrantDto(await prisma.accessGrant.create({ data: { ...data, createdBy } }));
}

/** Only a grant nobody has received yet can be revoked; applied credits are already spendable. */
export async function revokeAccessGrant(prisma: PrismaClient, id: string): Promise<AccessGrant> {
  const revoked = await prisma.accessGrant.updateMany({
    where: { id, organizationId: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  const row = await prisma.accessGrant.findUnique({ where: { id } });
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Grant not found" });
  if (revoked.count === 0 && !row.revokedAt)
    throw new ORPCError("CONFLICT", { message: "Already applied" });
  return accessGrantDto(row);
}

/**
 * Gives an owner the grants made out to their email, once that email is verified, so nobody can
 * sign up as someone else's address to take them. Each grant is claimed for the organization
 * before applying and the credit is idempotent, so an interrupted apply finishes on the next call.
 */
export async function applyAccessGrants(
  prisma: PrismaClient,
  input: { userId: string; email: string; organizationId: string },
): Promise<void> {
  const { organizationId } = input;
  const pending = {
    appliedAt: null,
    revokedAt: null,
    OR: [{ organizationId: null }, { organizationId }],
  };
  const grants = await prisma.accessGrant.findMany({
    where: { email: input.email.toLowerCase(), ...pending },
  });
  if (grants.length === 0) return;
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { emailVerified: true },
  });
  if (!user?.emailVerified) return;
  for (const grant of grants) {
    const claimed = await prisma.accessGrant.updateMany({
      where: { id: grant.id, ...pending },
      data: { organizationId },
    });
    if (claimed.count === 0) continue;
    if (grant.creditCents > 0)
      await reconcileCreditPurchase(prisma, organizationId, {
        id: `grant_${grant.id}`,
        amountCents: grant.creditCents,
      });
    await prisma.$transaction(async (tx) => {
      const applied = await tx.accessGrant.updateMany({
        where: { id: grant.id, appliedAt: null },
        data: { appliedAt: new Date() },
      });
      if (applied.count === 0) return;
      await tx.modelCreditAccount.upsert({
        where: { organizationId },
        create: { organizationId },
        update: {},
      });
      if (grant.freeMonths > 0)
        await extendByokFreePeriod(tx, organizationId, grant.freeMonths * FREE_MONTH_DAYS);
      // Picks the funding only for an organization that has not chosen one.
      await tx.modelCreditAccount.updateMany({
        where: { organizationId, mode: null },
        data: { mode: grant.creditCents > 0 ? "credits" : "byok" },
      });
    });
  }
}
