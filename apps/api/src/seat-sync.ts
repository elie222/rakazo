import type { JobPublisher, JobTransaction } from "@rakazo/adapter-kit";
import { billingSeatsJob, billingSeatsJobKey } from "@rakazo/adapter-kit";
import type { PrismaClient, SeatChange } from "@rakazo/db";
import { whileSeatsAre } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import type { BillingService } from "./billing.js";

type SeatSyncDeps = {
  prisma: PrismaClient;
  jobs: Pick<JobPublisher, "enqueue" | "enqueueIn" | "cancelIn">;
  billing?: Pick<BillingService, "syncSeats">;
};

/** Past the provider calls a recount makes, so the backup rarely runs beside the direct one. */
const BACKUP_MS = 2 * 60_000;

function backupJob(organizationId: string) {
  return billingSeatsJob(organizationId, new Date(Date.now() + BACKUP_MS));
}

/**
 * For a transaction that changes who holds a paid seat: records the backup that recounts the
 * organization's seats if this process dies before {@link syncSeatsAfterChange} finishes.
 */
export function recordSeatChange(deps: SeatSyncDeps): SeatChange | undefined {
  const { billing, jobs } = deps;
  if (!billing) return undefined;
  return (tx: JobTransaction, organizationId: string) =>
    jobs.enqueueIn(tx, backupJob(organizationId));
}

/** The same backup for a change committed outside a transaction this code owns. */
export async function recordSeatChangeAhead(
  deps: SeatSyncDeps,
  organizationId: string,
): Promise<void> {
  if (deps.billing) await deps.jobs.enqueue(backupJob(organizationId));
}

/**
 * After the change commits: recount now. Success removes the backup unless membership changed
 * again since the count; a failure is logged and hands the recount to the backup at once.
 * Never rejects, so the seat count cannot change the caller's outcome.
 */
export async function syncSeatsAfterChange(
  deps: SeatSyncDeps,
  organizationId: string,
): Promise<void> {
  if (!deps.billing) return;
  let seats: number | null;
  try {
    seats = await deps.billing.syncSeats(organizationId);
  } catch (error) {
    getLogger().error("seat count failed; retrying", error);
    await bestEffort(
      "retry the seat count now",
      deps.jobs.enqueue(billingSeatsJob(organizationId)),
    );
    return;
  }
  await bestEffort(
    "delete the seat count's backup job",
    whileSeatsAre(deps.prisma, organizationId, seats, (tx) =>
      deps.jobs.cancelIn(tx, billingSeatsJobKey(organizationId)),
    ),
  );
}
