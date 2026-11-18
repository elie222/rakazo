/**
 * Graphile's side of `JobQueueOrder`. A job counts while it is queued, in backoff or running; one
 * that used up its attempts is finished, though Graphile keeps its row until the dead-job pruner
 * removes it.
 */
const UNFINISHED_IN_QUEUE = `
  from graphile_worker._private_jobs as jobs
  join graphile_worker._private_job_queues as queues on queues.id = jobs.job_queue_id
  where queues.queue_name = $1::text and jobs.key is distinct from $2::text
    and (jobs.attempts < jobs.max_attempts or jobs.locked_at is not null)`;

/** When the last unfinished job of queue $1, other than the one keyed $2, is due. */
export const PENDING_UNTIL_SQL = `select max(jobs.run_at) as run_at ${UNFINISHED_IN_QUEUE}`;

/**
 * Makes the followers at the head of queue $1 due now, a millisecond apart, up to the first job
 * that is not one or is running; the job keyed $2 is left out. The follower mark is read from the
 * stored payload, with or without its correlation wrapper, and a job without it is no follower.
 */
export const RELEASE_FOLLOWERS_SQL = `
  with queued as (
    select jobs.id, jobs.run_at, jobs.locked_at is null and coalesce(
        coalesce(jobs.payload->'payload'->>'follower', jobs.payload->>'follower') = 'true',
        false
      ) as follower
    ${UNFINISHED_IN_QUEUE}
  ), head as (
    select id, run_at, row_number() over (order by run_at, id) - 1 as place
    from queued
    where follower
      and run_at < coalesce(
        (select min(run_at) from queued where not follower), 'infinity'::timestamptz)
  )
  update graphile_worker._private_jobs as jobs
  set run_at = least(head.run_at, now() + head.place * interval '1 millisecond')
  from head
  where jobs.id = head.id`;

/** A job due late only so it runs after the jobs ahead of it in its named queue. */
export function isFollowerPayload(payload: unknown): boolean {
  return (payload as { follower?: unknown } | null)?.follower === true;
}
