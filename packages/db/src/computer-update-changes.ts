import type { RealtimeFanout } from "@rakazo/adapter-kit";
import { ChangeLatch } from "./event-stream.js";

const IDLE_WAIT_MS = 60_000;

const computerUpdatesTopic = (spaceId: string) => `computer-updates:${spaceId}`;

/** Best effort: an app that misses a signal catches up when its stream reopens. */
export async function publishComputerUpdateChange(
  realtime: RealtimeFanout | undefined,
  spaceId: string,
): Promise<void> {
  await realtime?.publish(computerUpdatesTopic(spaceId), "").catch(() => undefined);
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
