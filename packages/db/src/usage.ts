import type { AgentRuntimeEvent, UsageOperationKind } from "@rakazo/adapter-kit";
import type { PrismaClient } from "./generated/prisma/client.js";

type UsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }>;
export interface UsageAttribution {
  spaceId: string;
  userId: string;
  botId?: string;
  runId?: string;
  parentRunId?: string;
  operationId?: string;
  operationKind?: UsageOperationKind;
}

/** Usage is financial history, independent from message clearing or bot deletion. */
export async function recordUsage(
  prisma: Pick<PrismaClient, "usageRecord">,
  event: UsageEvent,
  attribution: UsageAttribution,
) {
  const data = {
    ...attribution,
    parentRunId: attribution.parentRunId ?? attribution.runId,
    provider: event.provider,
    model: event.model,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens ?? null,
    cacheWriteTokens: event.cacheWriteTokens ?? null,
    cacheWrite1hTokens: event.cacheWrite1hTokens ?? null,
    reasoningTokens: event.reasoningTokens ?? null,
    totalTokens: event.totalTokens ?? null,
    costUsd: event.costUsd ?? null,
    costSource: event.costSource ?? null,
    pricingVersion: event.pricingVersion ?? null,
    usageSource: event.usageSource ?? null,
    callId: event.callId ?? null,
    operationKind: attribution.operationKind ?? event.operationKind ?? "answer",
    agentId: event.agentId ?? null,
  };
  const insert = (runId: string | null | undefined = data.runId) => {
    if (event.callId) {
      // A database uniqueness constraint makes duplicate delivery harmless even concurrently.
      return prisma.usageRecord.createMany({ data: [{ ...data, runId }], skipDuplicates: true });
    }
    return prisma.usageRecord.create({
      data: { ...data, ...(runId !== undefined ? { runId } : {}) },
    });
  };
  try {
    return await insert();
  } catch (error) {
    // A cancelled/deleted run can disappear while its last model call is settling.
    // Keep durable attribution while allowing the optional lifecycle FK to dangle as null.
    if (
      data.runId &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2003"
    )
      return insert(null);
    throw error;
  }
}
