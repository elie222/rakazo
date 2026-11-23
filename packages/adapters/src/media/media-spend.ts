import type { GeneratedMedia } from "@rakazo/adapter-kit";
import type { MediaModelRole } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";

/** What one generation on the owner's own key cost them, kept with the model usage. */
export interface OwnKeyMediaSpend {
  role: MediaModelRole;
  provider: string;
  model: string;
  cost: GeneratedMedia["cost"];
}

/**
 * Records the spend once per job. The row's operation kind names the media, so model usage
 * totals leave it out; it is informational and never settles credits or limits.
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
        costUsd: spend.cost?.usd ?? null,
        costSource: spend.cost?.source ?? null,
        billing: "api_key",
        operationKind: spend.role,
        callId: `media:${jobId}`,
      },
    ],
    skipDuplicates: true,
  });
}
