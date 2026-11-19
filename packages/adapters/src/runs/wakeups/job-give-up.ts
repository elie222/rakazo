import { bestEffort, getLogger, unwrapJobPayload } from "@rakazo/logging";
import type { Job } from "graphile-worker";
import type { Pool } from "pg";

// Adapter-local task name: the shared job contract remains run.continue. Older
// publishers can keep publishing it while a new worker drains the legacy queue.
export const INTERACTIVE_RUN_TASK = "run.interactive";

export function jobType(taskIdentifier: string): string {
  return taskIdentifier === INTERACTIVE_RUN_TASK ? "run.continue" : taskIdentifier;
}

/**
 * Graphile emits this once a job's last attempt has failed: it keeps the row and never runs it
 * again. The payload stays out, since it can hold identifiers and references to secrets.
 */
type GaveUpJob = Pick<
  Job,
  "id" | "task_identifier" | "payload" | "attempts" | "max_attempts" | "created_at"
>;

export function recordJobGaveUp(job: GaveUpJob, error: unknown): void {
  const type = jobType(job.task_identifier);
  const { correlation } = unwrapJobPayload(job.payload);
  getLogger().error("job.gave_up", error instanceof Error ? error : new Error(String(error)), {
    "job.type": type,
    "job.queue_id": String(job.id),
    ...(correlation ? { "job.id": correlation.jobId, "trace.id": correlation.traceId } : {}),
    "job.attempts": job.attempts,
    "job.max_attempts": job.max_attempts,
    "job.queued_ms": Date.now() - job.created_at.getTime(),
    // The attempt's own failure is already reported; giving up is a separate issue per job type.
    "error.fingerprint": ["job.gave_up", type],
  });
}

/** Long enough to look into a job that gave up over a weekend or a holiday. */
export const DEAD_JOB_RETENTION_DAYS = 7;
const DEAD_JOB_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DEAD_JOB_PRUNE_BATCH = 1_000;
const DEAD_JOB_PRUNE_MAX_BATCHES = 50;

/**
 * A worker that dies during a job's last attempt leaves it locked and never fails it, so nothing is
 * reported, and at four hours the queue frees the lock as a dead worker's without a trace. Just
 * before that, the job is reported and failed instead; the queue would treat any job still holding
 * its lock by then as dead anyway.
 */
export const ABANDONED_LAST_ATTEMPT_MS = 3 * 60 * 60 * 1000 + 50 * 60 * 1000;
/** About 20,000 fit in the ten minutes before the queue frees them, at one pass per tick. */
const ABANDONED_LAST_ATTEMPT_BATCH = 1_000;
export const ABANDONED_LAST_ATTEMPT_ERROR = "The worker stopped during the last attempt";

/**
 * Graphile keeps a job that exhausted its retries forever, and its own maintenance scans them.
 * Delete them once they are old enough that nobody is still diagnosing the failure. Exhausted
 * `routine.retry` rows are notice requests, which their reconciler deletes after delivery.
 *
 * A failed attempt moves `run_at` to that moment plus backoff and leaves `updated_at` at the last
 * enqueue, so the later of the two is when the row was last touched; a job due in the future
 * never matches.
 *
 * Graphile's `cleanup` task deletes every exhausted job regardless of age or task, and
 * `completeJobs` deletes by id without rechecking, so a keyed job replaced back to life between
 * a select and the delete would go with it. This deletes in one statement that rechecks.
 */
export function createDeadJobPruner(
  pool: Pick<Pool, "query">,
  options: { retentionDays?: number; intervalMs?: number } = {},
): () => Promise<void> {
  const retentionDays = options.retentionDays ?? DEAD_JOB_RETENTION_DAYS;
  const intervalMs = options.intervalMs ?? DEAD_JOB_PRUNE_INTERVAL_MS;
  let lastRun: number | undefined;
  return async () => {
    // Every tick, so a dead last attempt is caught in the minutes before the queue frees it; a
    // failure here never holds up the pruning below.
    await bestEffort("fail abandoned last attempts", failAbandonedLastAttempts(pool));
    const now = Date.now();
    if (lastRun !== undefined && now - lastRun < intervalMs) return;
    lastRun = now;
    const removedByType = new Map<string, number>();
    for (let batch = 0; batch < DEAD_JOB_PRUNE_MAX_BATCHES; batch += 1) {
      const { rows } = await pool.query<{ identifier: string; removed: number }>(
        `with removed as (
           delete from graphile_worker._private_jobs as jobs
           where jobs.id in (
             select dead.id
             from graphile_worker._private_jobs as dead
             join graphile_worker._private_tasks as tasks on tasks.id = dead.task_id
             where dead.attempts >= dead.max_attempts and dead.locked_at is null
               and dead.updated_at < now() - make_interval(days => $1::int)
               and dead.run_at < now() - make_interval(days => $1::int)
               and tasks.identifier <> 'routine.retry'
             order by dead.id
             limit $2
             for update of dead skip locked
           )
           and jobs.attempts >= jobs.max_attempts and jobs.locked_at is null
           returning jobs.task_id
         )
         select tasks.identifier, count(*)::int as removed
         from removed
         join graphile_worker._private_tasks as tasks on tasks.id = removed.task_id
         group by tasks.identifier`,
        [retentionDays, DEAD_JOB_PRUNE_BATCH],
      );
      let removed = 0;
      for (const row of rows) {
        const type = jobType(row.identifier);
        removedByType.set(type, (removedByType.get(type) ?? 0) + row.removed);
        removed += row.removed;
      }
      if (removed < DEAD_JOB_PRUNE_BATCH) break;
    }
    if (removedByType.size === 0) return;
    const byType = [...removedByType].sort(([a], [b]) => a.localeCompare(b));
    getLogger().info("jobs.dead_pruned", {
      "jobs.removed": byType.reduce((total, [, count]) => total + count, 0),
      "jobs.removed_by_type": byType.map(([type, count]) => `${type}=${count}`).join(","),
    });
  };
}

/** Reports before it fails, so a crash in between repeats a report rather than losing one. */
async function failAbandonedLastAttempts(pool: Pick<Pool, "query">): Promise<void> {
  const { rows } = await pool.query<GaveUpJob>(
    `select jobs.id, tasks.identifier as task_identifier, jobs.payload, jobs.attempts,
       jobs.max_attempts, jobs.created_at
     from graphile_worker._private_jobs as jobs
     join graphile_worker._private_tasks as tasks on tasks.id = jobs.task_id
     where jobs.attempts >= jobs.max_attempts
       and jobs.locked_at < now() - $1::int * interval '1 millisecond'
     order by jobs.id
     limit $2`,
    [ABANDONED_LAST_ATTEMPT_MS, ABANDONED_LAST_ATTEMPT_BATCH],
  );
  if (rows.length === 0) return;
  for (const job of rows) recordJobGaveUp(job, new Error(ABANDONED_LAST_ATTEMPT_ERROR));
  await pool.query(
    `update graphile_worker._private_jobs
     set locked_at = null, locked_by = null, last_error = $3::text, updated_at = now()
     where id = any($1::bigint[]) and attempts >= max_attempts
       and locked_at < now() - $2::int * interval '1 millisecond'`,
    [rows.map((job) => job.id), ABANDONED_LAST_ATTEMPT_MS, ABANDONED_LAST_ATTEMPT_ERROR],
  );
}
