import { unlink, writeFile } from "node:fs/promises";
import { getHeapStatistics } from "node:v8";
import { getLogger, logSinkHealth } from "@rakazo/logging";

export const WORKER_HEALTH_FILE = "/tmp/rakazo-worker-health.json";

/** A separate Docker process can detect a dead or blocked worker even when it cannot log. */
export function startWorkerHealth(lastReconciled: () => number) {
  let stopped = false;
  let writing: Promise<void> | undefined;
  const publish = () => {
    if (writing || stopped) return;
    writing = writeFile(
      WORKER_HEALTH_FILE,
      JSON.stringify({
        heartbeat: Date.now(),
        reconciled: lastReconciled(),
        telemetry: logSinkHealth(),
      }),
      { mode: 0o600 },
    )
      .catch((error) => {
        getLogger().error("worker heartbeat failed", error);
      })
      .finally(() => {
        writing = undefined;
      });
  };
  void publish();
  const timer = setInterval(() => void publish(), 30_000);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await writing;
    await unlink(WORKER_HEALTH_FILE).catch(() => undefined);
  };
}

const STALL_CHECK_MS = 1_000;
const STALL_REPORT_MS = 5_000;

/**
 * A blocked event loop fires every pending checkout and transaction timeout at once when it
 * resumes. Heap figures tell garbage collection near the heap limit apart from synchronous work.
 */
export function watchEventLoopStalls(now: () => number = Date.now): () => void {
  let last = now();
  const timer = setInterval(() => {
    const at = now();
    const stallMs = at - last - STALL_CHECK_MS;
    last = at;
    if (stallMs < STALL_REPORT_MS) return;
    const heap = getHeapStatistics();
    const memory = process.memoryUsage();
    getLogger().warn("worker.event_loop_stalled", {
      "event_loop.stall_ms": stallMs,
      "memory.heap_used_bytes": heap.used_heap_size,
      "memory.heap_limit_bytes": heap.heap_size_limit,
      "memory.external_bytes": memory.external,
      "memory.rss_bytes": memory.rss,
    });
  }, STALL_CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export function workerHealthIsFresh(value: unknown, now = Date.now()): boolean {
  if (!value || typeof value !== "object") return false;
  const health = value as Record<string, unknown>;
  const checks = [
    ["heartbeat", 90_000],
    ["reconciled", 300_000],
  ] as const;
  return checks.every(([key, limit]) => {
    const timestamp = health[key];
    return (
      typeof timestamp === "number" &&
      Number.isFinite(timestamp) &&
      timestamp > 0 &&
      timestamp <= now + 5_000 &&
      now - timestamp <= limit
    );
  });
}
