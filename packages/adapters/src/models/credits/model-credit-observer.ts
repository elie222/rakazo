import type { ModelCallObserver } from "@rakazo/adapter-kit";
import { HOSTED_MODEL_CREDITS_REQUIRED_ERROR } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  creditAccount,
  organizationForMember,
  recordModelCreditReceipt,
  reserveModelCredits,
} from "@rakazo/db";

import { modelCreditOfferings, offeringUsage } from "../../model-credits/offerings.js";
import { maximumModelCallCost } from "../../runtime/pi/usage/pi-usage.js";

export class HostedModelCreditsRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedModelCreditsRequiredError";
  }
}

/** The member belongs to no organization that could hold model credits. */
export class ModelCreditAccountUnavailableError extends Error {
  constructor() {
    super("Model credit account is unavailable");
    this.name = "ModelCreditAccountUnavailableError";
  }
}

/** Only deployment credentials are metered; a personal connection never reaches this boundary. */
export async function hostedModelCreditObserver(
  prisma: PrismaClient,
  scope: { userId: string; spaceId: string },
): Promise<ModelCallObserver> {
  const membership = await organizationForMember(prisma, scope);
  if (!membership) throw new ModelCreditAccountUnavailableError();
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
      if (offering && call.maxOutputTokens === null && offering.price.output > 0)
        throw new HostedModelCreditsRequiredError("This protocol requires a zero output tariff");
      const maximum = offering
        ? maximumModelCallCost(
            offering.price,
            call.inputTokensEstimate,
            call.maxOutputTokens ?? 0,
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
          ...(offering
            ? {
                usage: offeringUsage(offering, {
                  inputTokens: null,
                  outputTokens: null,
                  costUsd: null,
                  usageSource: "pending",
                })!,
              }
            : {}),
        },
      );
      if (offering) snapshots.set(reservation, offering);
      return reservation;
    },
    afterCall: async (reservationId, usage) => {
      const offering = snapshots.get(reservationId);
      const receipt = usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        usageSource: "not-started",
      };
      const priced = offering ? offeringUsage(offering, receipt) : receipt;
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
