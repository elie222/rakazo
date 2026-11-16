import type { JobPublisher } from "@rakazo/adapter-kit";
import { runForgetSecretsJob } from "@rakazo/adapter-kit";
import { idleRunSecretsAfterMs } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import { expireWaitHoldingSecrets } from "./stuck-work.js";

/** A paused run may keep its run-only logins and codes only until the expiry. */
export async function scheduleRunSecretsExpiry(jobs: JobPublisher, runId: string): Promise<void> {
  await bestEffort(
    "run secrets expiry schedule",
    jobs.enqueue(runForgetSecretsJob(runId, new Date(Date.now() + idleRunSecretsAfterMs()))),
  );
}

export async function expireRunSecrets(
  deps: Parameters<typeof expireWaitHoldingSecrets>[0],
  runId: string,
): Promise<void> {
  const later = await expireWaitHoldingSecrets(deps, runId);
  if (later) await deps.jobs.enqueue(runForgetSecretsJob(runId, later));
}
