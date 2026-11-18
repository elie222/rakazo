import type { JobPublisher, JobTransaction } from "@rakazo/adapter-kit";
import { runForgetSecretsJob } from "@rakazo/adapter-kit";
import { waitExpireAfterMs } from "@rakazo/core";
import { expireWaitHoldingSecrets } from "../runs/lifecycle/stuck-work.js";

/** A paused run may keep its run-only logins and codes only until the expiry. Commits with the pause. */
export function scheduleRunSecretsExpiry(
  jobs: JobPublisher,
  runId: string,
): (tx: JobTransaction) => Promise<void> {
  return (tx) =>
    jobs.enqueueIn(tx, runForgetSecretsJob(runId, new Date(Date.now() + waitExpireAfterMs())));
}

export async function expireRunSecrets(
  deps: Parameters<typeof expireWaitHoldingSecrets>[0],
  runId: string,
): Promise<void> {
  const later = await expireWaitHoldingSecrets(deps, runId);
  if (later) await deps.jobs.enqueue(runForgetSecretsJob(runId, later));
}
