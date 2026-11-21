import type { PrismaClient } from "@rakazo/db";
import { chatHistoryRetentionDays, deleteExpiredToolCallRecords, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/**
 * Deletes tool call traces past their retention, or past the deployment's chat history retention
 * when that is shorter. A slow safety net, not the main path: records are written by the run that
 * made them and read within days, so an hourly sweep only has to catch what time left behind. The
 * tenant policy keeps every ordinary reader to one Space, so the delete runs as the system, in
 * bounded batches, and stops between them on shutdown.
 */
export function toolCallRecordRetentionSweep(deps: { prisma: PrismaClient }) {
  const chatHistoryDays = chatHistoryRetentionDays();
  return async (signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return;
    const deleted = await runAsSystem("expire tool call records", () =>
      deleteExpiredToolCallRecords(deps.prisma, { signal, chatHistoryDays }),
    );
    if (deleted > 0) getLogger().info("tool call records expired", { "records.deleted": deleted });
  };
}
