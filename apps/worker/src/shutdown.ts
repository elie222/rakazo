import { setTimeout as sleep } from "node:timers/promises";
import { getLogger } from "@rakazo/logging";

/** How long a shutdown step that is not the drain of running work may hold the exit. */
export const SHUTDOWN_STEP_TIMEOUT_MS = 10_000;

/**
 * Shutdown steps between a stop signal and the exit are best effort: the step keeps running,
 * but a dependency that stops answering — a database under load — must not hold the process,
 * and with it the container's stop grace period, open until Docker kills it. Draining running
 * work is not a step to bound here; the job host bounds it under JOB_DRAIN_TIMEOUT_MS.
 * A step that fails still rejects; only the wait for it is bounded.
 */
export async function stopWithin(
  step: Promise<unknown>,
  label: string,
  timeoutMs: number = SHUTDOWN_STEP_TIMEOUT_MS,
): Promise<void> {
  step.catch(() => undefined); // A late failure after the bound wins must not stay unhandled.
  const timedOut = await Promise.race([
    step.then(() => false as const),
    sleep(timeoutMs).then(() => true as const),
  ]);
  if (timedOut) getLogger().warn("worker.shutdown_step_timed_out", { step: label });
}
