import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";

/**
 * Nudges a committed run to start now, or at `at`. It never rejects: the run row is the durable
 * record and recovery starts a run whose nudge was lost, so a failed nudge must not fail the
 * work that recorded the run. `keepExisting` leaves a wake time the run already has.
 */
export async function wakeRun(
  jobs: Pick<JobPublisher, "enqueue">,
  runId: string,
  options: { at?: Date; keepExisting?: boolean } = {},
): Promise<void> {
  try {
    await jobs.enqueue({
      ...runContinueJob(runId),
      ...(options.at ? { availableAt: options.at } : {}),
      ...(options.keepExisting ? { keepExisting: true } : {}),
    });
  } catch (error) {
    getLogger().error("run wake failed", error, { "run.id": runId });
  }
}
