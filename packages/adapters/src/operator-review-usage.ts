import { randomUUID } from "node:crypto";
import type { AgentRuntimeEvent, ModelCallObserver } from "@rakazo/adapter-kit";
import type { PrismaClient, UsageAttribution } from "@rakazo/db";
import { hasBillingAccess, organizationForMember, recordUsage } from "@rakazo/db";
import { decisionModel } from "./decision-models.js";

/** Trials and free periods alone do not fund the included checker. */
export async function requirePaidReviewAccount(
  prisma: PrismaClient,
  scope: { userId: string; spaceId: string },
) {
  const member = await organizationForMember(prisma, scope);
  const billing = member
    ? await prisma.billingAccount.findUnique({ where: { organizationId: member.organizationId } })
    : null;
  if (!billing?.paidAt || !hasBillingAccess(billing.status))
    throw new Error("Included checker requires a paid account");
}

/** Record intent before dispatch, so a process loss leaves an explicitly unknown expense. */
export function operatorReviewObserver(
  prisma: PrismaClient,
  attribution: UsageAttribution,
): ModelCallObserver {
  const calls = new Map<string, Extract<AgentRuntimeEvent, { type: "usage" }>>();
  const scope = { ...attribution, fundingSource: "operator" as const };
  return {
    async beforeCall(call) {
      const callId = call.callId ?? randomUUID();
      const pricing = decisionModel(call.provider, call.modelId);
      const event = {
        type: "usage" as const,
        callId,
        pricingVersion: pricing?.pricingVersion ?? null,
        pricingSnapshot: pricing
          ? { input: pricing.inputUsdPerMillion, output: 0, source: pricing.pricingUrl }
          : null,
        provider: call.provider,
        model: call.modelId,
        inputTokens: null,
        outputTokens: null,
        usageSource: "dispatch-pending",
      };
      await recordUsage(prisma, event, scope);
      calls.set(callId, event);
      return callId;
    },
    async onRequestId(id, providerRequestId) {
      const event = calls.get(id);
      if (!event) throw new Error("Unknown checker expense");
      event.providerRequestId = providerRequestId;
      await recordUsage(prisma, event, scope, true);
    },
    async afterCall(id, usage) {
      const event = calls.get(id);
      if (!event) throw new Error("Unknown checker expense");
      await recordUsage(
        prisma,
        {
          ...event,
          ...(usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, usageSource: "not-sent" }),
        },
        scope,
        true,
      );
      calls.delete(id);
    },
  };
}
