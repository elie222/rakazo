import type { ModelCallObserver } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  billingAccountForOrganization,
  creditAccount,
  hasBillingAccess,
  organizationForMember,
  recordModelCreditReceipt,
  reserveModelCredits,
} from "@rakazo/db";

export class HostedModelCreditsRequiredError extends Error {}

/** Only deployment credentials are metered; a personal connection never reaches this boundary. */
export async function hostedModelCreditObserver(
  prisma: PrismaClient,
  scope: { userId: string; spaceId: string },
): Promise<ModelCallObserver | undefined> {
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { ownerUserId: true },
  });
  if (settings?.ownerUserId === scope.userId) return undefined;
  const membership = await organizationForMember(prisma, scope);
  if (!membership) throw new Error("Model credit account is unavailable");
  const legacy = await billingAccountForOrganization(prisma, membership.organizationId);
  if (legacy && legacy.creditAmountCents == null && hasBillingAccess(legacy.status))
    return undefined;
  const account = await creditAccount(prisma, membership.organizationId);
  if (account.mode !== "credits")
    throw new HostedModelCreditsRequiredError(
      "Connect your own API key in Models or choose Rakazo credits in Billing.",
    );
  return {
    beforeCall: (call) =>
      reserveModelCredits(prisma, membership.organizationId, call.maxCostUsd ?? Number.NaN, {
        callId: call.callId,
        userId: scope.userId,
        spaceId: scope.spaceId,
        runId: call.runId,
        provider: call.provider,
        model: call.modelId,
      }),
    afterCall: (reservationId, usage) => recordModelCreditReceipt(prisma, reservationId, usage),
    onRequestId: async (id, providerRequestId) => {
      await prisma.modelCreditEntry.updateMany({
        where: { id, providerRequestId: null },
        data: { providerRequestId },
      });
    },
  };
}
