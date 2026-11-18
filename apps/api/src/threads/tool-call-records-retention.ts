import type { PrismaClient } from "@rakazo/db";
import { deleteExpiredToolCallRecords, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/**
 * Deletes tool call traces past their retention. A slow safety net, not the main path: records are
 * written by the run that made them and read within days, so an hourly sweep only has to catch what
 * time left behind. The tenant policy keeps every ordinary reader to one Space, so the delete runs
 * as the system, in bounded batches.
 */
export function toolCallRecordRetentionSweep(deps: { prisma: PrismaClient }) {
  return async (signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return;
    const deleted = await runAsSystem("expire tool call records", () =>
      deleteExpiredToolCallRecords(deps.prisma),
    );
    if (deleted > 0) getLogger().info("tool call records expired", { "records.deleted": deleted });
  };
}
