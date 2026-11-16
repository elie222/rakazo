import type { JobPublisher } from "@rakazo/adapter-kit";
import { runForgetSecretsJob } from "@rakazo/adapter-kit";
import { idleRunSecretsAfterMs } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { forgetIdleRunSecrets } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";

/** A paused run keeps its run-only logins and codes only until the expiry, though its question stays open. */
export async function scheduleRunSecretsExpiry(jobs: JobPublisher, runId: string): Promise<void> {
  await bestEffort(
    "run secrets expiry schedule",
    jobs.enqueue(runForgetSecretsJob(runId, new Date(Date.now() + idleRunSecretsAfterMs()))),
  );
}

export async function expireRunSecrets(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  runId: string,
): Promise<void> {
  const later = await forgetIdleRunSecrets(
    deps.prisma,
    runId,
    new Date(Date.now() - idleRunSecretsAfterMs()),
  );
  if (later) await deps.jobs.enqueue(runForgetSecretsJob(runId, later.retryAfter));
}
