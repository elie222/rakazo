import { bestEffort, getLogger } from "@rakazo/logging";
import type Docker from "dockerode";

/** A computer whose every command fails costs one reading in this time. */
const READING_INTERVAL_MS = 60_000;
const NEAR_LIMIT_SHARE = 0.9;
const lastReadingAt = new Map<string, number>();

/**
 * A computer at its PID or memory limit fails commands without naming the limit, so a failed one
 * has it read.
 */
export function warnNearLimits(container: Docker.Container): void {
  const now = Date.now();
  const last = lastReadingAt.get(container.id);
  if (last !== undefined && now - last < READING_INTERVAL_MS) return;
  lastReadingAt.set(container.id, now);
  void bestEffort("read a computer's resource limits", reportNearLimits(container));
}

async function reportNearLimits(container: Docker.Container): Promise<void> {
  const stats = await container.stats({ stream: false, "one-shot": true });
  const log = getLogger();
  const pids = nearLimit(stats.pids_stats?.current, stats.pids_stats?.limit);
  if (pids)
    log.warn("computer.pids_near_limit", {
      "container.id": container.id,
      "pids.current": pids.current,
      "pids.limit": pids.limit,
    });
  // The kernel frees idle file cache before it kills a process for memory, so it is not counted.
  const memory = stats.memory_stats;
  const resident = nearLimit(
    (memory.usage ?? 0) - (memory.stats?.inactive_file ?? 0),
    memory.limit,
  );
  if (resident)
    log.warn("computer.memory_near_limit", {
      "container.id": container.id,
      "memory.current": resident.current,
      "memory.limit": resident.limit,
    });
}

function nearLimit(current = 0, limit = 0): { current: number; limit: number } | undefined {
  return limit > 0 && current >= limit * NEAR_LIMIT_SHARE ? { current, limit } : undefined;
}
