import { randomUUID } from "node:crypto";
import type { AgentRuntimeEvent, ModelCallObserver } from "@rakazo/adapter-kit";
import type { PrismaClient, UsageAttribution } from "@rakazo/db";
import { recordUsage } from "@rakazo/db";
import { decisionInputCost, decisionModel } from "./decision-models.js";

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
          ? {
              input: pricing.inputUsdPerMillion,
              output: 0,
              source: pricing.pricingUrl,
              estimatedInputTokens: call.inputTokensEstimate,
            }
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
      const pricing = decisionModel(event.provider, event.model);
      const reportedEstimate = usage?.pricingSnapshot?.estimatedInputTokens;
      const input =
        usage?.inputTokens ??
        (typeof reportedEstimate === "number" &&
        Number.isFinite(reportedEstimate) &&
        reportedEstimate >= 0
          ? reportedEstimate
          : event.pricingSnapshot?.estimatedInputTokens);
      const estimate =
        usage && usage.costUsd == null && pricing && typeof input === "number"
          ? {
              costUsd: decisionInputCost(pricing, input),
              costSource: usage.inputTokens == null ? "request-token-estimate" : "catalog-estimate",
            }
          : {};
      await recordUsage(
        prisma,
        {
          ...event,
          ...(usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, usageSource: "not-sent" }),
          ...estimate,
          pricingSnapshot: {
            ...event.pricingSnapshot,
            ...usage?.pricingSnapshot,
            ...(estimate.costSource === "request-token-estimate"
              ? { estimatedInputTokens: input }
              : {}),
          },
        },
        scope,
        true,
      );
      calls.delete(id);
    },
  };
}
