import type { ModelCallObserver } from "@rakazo/adapter-kit";
import { HOSTED_MODEL_CREDITS_REQUIRED_ERROR } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  creditAccount,
  organizationForMember,
  recordModelCreditReceipt,
  reserveModelCredits,
} from "@rakazo/db";

import { modelCreditOfferings, offeringUsage } from "./model-credit-offerings.js";
import { maximumModelCallCost } from "./pi-usage.js";

export class HostedModelCreditsRequiredError extends Error {}

/** Only deployment credentials are metered; a personal connection never reaches this boundary. */
export async function hostedModelCreditObserver(
  prisma: PrismaClient,
  scope: { userId: string; spaceId: string },
): Promise<ModelCallObserver> {
  const membership = await organizationForMember(prisma, scope);
  if (!membership) throw new Error("Model credit account is unavailable");
  const account = await creditAccount(prisma, membership.organizationId);
  if (account.mode !== "credits" && account.balanceMicros <= 0n)
    throw new HostedModelCreditsRequiredError(HOSTED_MODEL_CREDITS_REQUIRED_ERROR);
  const configuration = modelCreditOfferings();
  const snapshots = new Map<string, NonNullable<typeof configuration>["offerings"][number]>();
  return {
    beforeCall: async (call) => {
      const offering = configuration?.offerings.find(
        (entry) => entry.provider === call.provider && entry.modelId === call.modelId,
      );
      if (configuration && !offering)
        throw new HostedModelCreditsRequiredError("This model requires a personal connection");
      const maximum = offering
        ? maximumModelCallCost(
            offering.price,
            call.inputTokensEstimate,
            call.maxOutputTokens,
            call.cacheWriteRetention,
          )
        : call.maxCostUsd;
      const reservation = await reserveModelCredits(
        prisma,
        membership.organizationId,
        maximum ?? Number.NaN,
        {
          callId: call.callId,
          userId: scope.userId,
          spaceId: scope.spaceId,
          runId: call.runId,
          provider: call.provider,
          model: call.modelId,
          ...(offering ? { usage: offeringUsage(offering, null)! } : {}),
        },
      );
      if (offering) snapshots.set(reservation, offering);
      return reservation;
    },
    afterCall: async (reservationId, usage) => {
      const offering = snapshots.get(reservationId);
      const priced = offering ? offeringUsage(offering, usage) : usage;
      await recordModelCreditReceipt(prisma, reservationId, priced);
      if (offering) snapshots.delete(reservationId);
      return priced ?? undefined;
    },
    onRequestId: async (id, providerRequestId) => {
      await prisma.modelCreditEntry.updateMany({
        where: { id, providerRequestId: null },
        data: { providerRequestId },
      });
    },
  };
}
