import { setTimeout as sleep } from "node:timers/promises";

/**
 * How long the worker waits for its database pool to close once every job host has stopped. By
 * then only work the hosts gave up on can still hold a connection, such as Graphile's listener
 * whose unlisten never answered; pool.end() waits for every checked-out connection, so it would
 * hold the process, and with it the container's stop grace period, until Docker kills it.
 */
const POOL_END_TIMEOUT_MS = 5_000;

export async function endDatabasePool(
  pool: { end(): Promise<void> },
  timeoutMs = POOL_END_TIMEOUT_MS,
): Promise<void> {
  await Promise.race([
    pool.end().catch(() => undefined),
    sleep(timeoutMs, undefined, { ref: false }),
  ]);
}
