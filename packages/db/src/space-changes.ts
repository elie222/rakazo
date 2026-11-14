import type { RealtimeFanout } from "@rakazo/adapter-kit";
import { SpaceChangeKind } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import { retryWhileDatabaseUnavailable } from "./database-outage.js";
import { ChangeLatch } from "./event-stream.js";

const IDLE_WAIT_MS = 60_000;

const spaceChangesTopic = (spaceId: string) => `space-changes:${spaceId}`;
// Workers from the previous release still announce computer updates here until they drain.
const legacyComputerUpdatesTopic = (spaceId: string) => `computer-updates:${spaceId}`;

const PUBLISH_RETRY_MS = 15_000;

/**
 * Apps re-read what a kind covers only on these signals, so a publish rides out a short database
 * outage in the background, without holding up the request or step that changed it. Past that it
 * gives up; apps catch up when their stream reopens. Call it after the change commits.
 */
export function publishSpaceChange(
  realtime: RealtimeFanout | undefined,
  spaceId: string,
  kind: SpaceChangeKind,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  if (realtime)
    void retryWhileDatabaseUnavailable(() => realtime.publish(spaceChangesTopic(spaceId), kind), {
      source: `${kind} signal`,
      waitMs: PUBLISH_RETRY_MS,
      ...options,
    }).catch((error: unknown) => getLogger().warn("space change signal not published", { error }));
  return Promise.resolve();
}

/**
 * Yields every kind once when following starts, then each kind that may have changed in the
 * Space. Signals carry no content, and a burst of one kind that arrives before the reader asks
 * again becomes one.
 */
export async function* followSpaceChanges(
  realtime: RealtimeFanout,
  spaceId: string,
  signal?: AbortSignal,
): AsyncGenerator<SpaceChangeKind> {
  const latch = new ChangeLatch();
  const pending = new Set<SpaceChangeKind>(SpaceChangeKind.options);
  const changed = (kind: SpaceChangeKind) => {
    pending.add(kind);
    latch.notify();
  };
  const unsubscribe = await realtime.subscribe(spaceChangesTopic(spaceId), (payload) => {
    // An empty payload is the fanout's catch-up after its listener reconnects: anything may have changed.
    if (payload === "") for (const kind of SpaceChangeKind.options) changed(kind);
    const kind = SpaceChangeKind.safeParse(payload);
    if (kind.success) changed(kind.data);
  });
  const unsubscribeLegacy = await realtime
    .subscribe(legacyComputerUpdatesTopic(spaceId), () => changed("computerUpdates"))
    .catch(async (error: unknown) => {
      await unsubscribe();
      throw error;
    });
  try {
    while (!signal?.aborted) {
      const seen = latch.generation;
      const kinds = [...pending];
      pending.clear();
      for (const kind of kinds) yield kind;
      await latch.waitForChange(seen, IDLE_WAIT_MS, signal);
    }
  } finally {
    await unsubscribeLegacy();
    await unsubscribe();
  }
}
