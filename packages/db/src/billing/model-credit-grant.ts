import { MODEL_CREDIT_GRANT_CENTS } from "@rakazo/core";
import type { PrismaClient } from "../database/client.js";
import { hasBillingAccess, isOwnerRole } from "./billing.js";
import { prepareCreditLots, syncLotBalance } from "./model-credit-lots.js";
import { creditAccount } from "./model-credits.js";

/** The entry, its lot and its journal source share one id, so one organization holds one grant. */
export const modelCreditGrantId = (organizationId: string) => `grant:${organizationId}`;

export type ModelCreditGrant = "granted" | "already-granted" | "ineligible";

/**
 * Gives an own-key plan its one-time model credit. A retry finds the organization's grant and
 * gives nothing more; an owner who was given one for another organization gets none. Only a
 * running own-key plan that is not cancelling is eligible.
 */
export async function grantModelCredit(
  prisma: PrismaClient,
  target: { organizationId: string; ownerUserId: string },
  now = new Date(),
): Promise<ModelCreditGrant> {
  const { organizationId, ownerUserId } = target;
  const id = modelCreditGrantId(organizationId);
  await creditAccount(prisma, organizationId);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "organizationId" FROM model_credit_accounts WHERE "organizationId"=${organizationId} FOR UPDATE`;
    if (await tx.modelCreditEntry.findUnique({ where: { source: id }, select: { id: true } }))
      return "already-granted";
    const organization = await tx.organization.findUnique({
      where: { id: organizationId },
      select: {
        billing: { select: { status: true, creditAmountCents: true, cancelAtPeriodEnd: true } },
        modelCredits: { select: { mode: true } },
      },
    });
    const billing = organization?.billing;
    if (
      !billing ||
      !hasBillingAccess(billing.status) ||
      billing.cancelAtPeriodEnd ||
      billing.creditAmountCents ||
      organization.modelCredits?.mode !== "byok"
    )
      return "ineligible";
    const owner = await tx.user.findFirst({
      where: { id: ownerUserId, modelCreditGrantedAt: null },
      select: { members: { where: { organizationId }, select: { role: true } } },
    });
    if (!owner?.members.some(({ role }) => isOwnerRole(role))) return "ineligible";
    const claimed = await tx.user.updateMany({
      where: { id: ownerUserId, modelCreditGrantedAt: null },
      data: { modelCreditGrantedAt: now },
    });
    if (claimed.count !== 1) return "ineligible";
    const amountMicros = BigInt(MODEL_CREDIT_GRANT_CENTS) * 10_000n;
    const withheldMicros = await prepareCreditLots(tx, organizationId, now);
    await tx.modelCreditEntry.create({ data: { id, source: id, organizationId, amountMicros } });
    await tx.modelCreditAccount.update({
      where: { organizationId },
      data: { balanceMicros: { increment: amountMicros } },
    });
    await tx.modelCreditLot.create({
      data: { id, organizationId, amountMicros, availableMicros: amountMicros },
    });
    // A balance below zero (a lost dispute's debt) is repaid from the grant like any other credit.
    await syncLotBalance(tx, organizationId, withheldMicros);
    return "granted";
  });
}

/**
 * Records the first spend of an organization's grant. True for exactly one caller, once a call
 * has drawn on it.
 */
export async function claimFirstGrantSpend(
  prisma: PrismaClient,
  organizationId: string,
): Promise<boolean> {
  const claimed = await prisma.$executeRaw`
    UPDATE model_credit_accounts SET "grantSpentAt" = now()
    WHERE "organizationId" = ${organizationId} AND "grantSpentAt" IS NULL
      AND EXISTS (
        SELECT 1 FROM model_credit_lots
        WHERE id = ${modelCreditGrantId(organizationId)} AND "usedMicros" > 0
      )`;
  return claimed === 1;
}
