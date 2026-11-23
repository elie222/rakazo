import type { MediaModelRole } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";

/** What one generation on the owner's own key cost them, kept with the model usage. */
export interface OwnKeyMediaSpend {
  role: MediaModelRole;
  provider: string;
  model: string;
  /** What it cost in micro-dollars: from the response, or the model's saved price when `estimated`. */
  costMicros: number;
  estimated: boolean;
}

/**
 * Records the spend once per job. The row's operation kind names the media, which counts no
 * tokens; it is informational and never settles credits or limits.
 */
export async function recordOwnKeyMediaSpend(
  tx: Prisma.TransactionClient,
  run: { id: string; botId: string; userId: string; spaceId: string },
  jobId: string,
  spend: OwnKeyMediaSpend,
) {
  await tx.usageRecord.createMany({
    data: [
      {
        spaceId: run.spaceId,
        userId: run.userId,
        botId: run.botId,
        runId: run.id,
        parentRunId: run.id,
        provider: spend.provider,
        model: spend.model,
        costUsd: spend.costMicros / 1_000_000,
        costSource: spend.estimated ? "catalog-estimate" : "provider-reported",
        billing: "api_key",
        operationKind: spend.role,
        callId: `media:${jobId}`,
      },
    ],
    skipDuplicates: true,
  });
}
