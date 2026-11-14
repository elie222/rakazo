import type { RealtimeFanout } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { retryWhileDatabaseUnavailable } from "./database-outage.js";
import { ChangeLatch } from "./event-stream.js";

const IDLE_WAIT_MS = 60_000;

const computerUpdatesTopic = (spaceId: string) => `computer-updates:${spaceId}`;

const PUBLISH_RETRY_MS = 15_000;

/**
 * Apps re-read computer updates only on these signals, so a publish rides out a short database
 * outage in the background, without holding up the request or update step that changed it. Past
 * that it gives up; apps catch up when their stream reopens.
 */
export function publishComputerUpdateChange(
  realtime: RealtimeFanout | undefined,
  spaceId: string,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  if (realtime)
    void retryWhileDatabaseUnavailable(() => realtime.publish(computerUpdatesTopic(spaceId), ""), {
      source: "computer update signal",
      waitMs: PUBLISH_RETRY_MS,
      ...options,
    }).catch((error: unknown) =>
      getLogger().warn("computer update signal not published", { error }),
    );
  return Promise.resolve();
}

/**
 * Signals once when following starts, then whenever the Space's computer updates may have changed.
 * Signals carry no content, and a burst that arrives before the reader asks again becomes one.
 */
export async function* followComputerUpdateChanges(
  realtime: RealtimeFanout,
  spaceId: string,
  signal?: AbortSignal,
): AsyncGenerator<void> {
  const latch = new ChangeLatch();
  const unsubscribe = await realtime.subscribe(computerUpdatesTopic(spaceId), () => latch.notify());
  try {
    let seen = latch.generation;
    yield;
    while (!signal?.aborted) {
      await latch.waitForChange(seen, IDLE_WAIT_MS, signal);
      if (signal?.aborted || latch.generation === seen) continue;
      seen = latch.generation;
      yield;
    }
  } finally {
    await unsubscribe();
  }
}
