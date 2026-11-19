import type { QueuedAhead } from "@rakazo/adapter-kit";

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

/**
 * When the last unfinished job of queue $1 queued ahead of the one keyed $2 is due: all of them
 * while that one is not queued. A job keeps its id when replaced, so its place is when it was
 * first recorded. `own` says whether the one keyed $2 is recorded at all, read in the same query.
 */
export const PENDING_UNTIL_SQL = `
  with own as (select id from graphile_worker._private_jobs where key = $2::text)
  select
    (select max(jobs.run_at) ${UNFINISHED_IN_QUEUE}
      and jobs.id < coalesce((select id from own), 9223372036854775807)) as run_at,
    exists (select 1 from own) as own`;

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

/** A job of a named queue, as the in-memory queue applies the same rules to it. */
export type OrderedJob = {
  key?: string;
  /** When it was first queued; replacing it keeps its place. */
  place: number;
  dueAt: number;
  running: boolean;
  follower: boolean;
};

/** `PENDING_UNTIL_SQL` over jobs held in memory. */
export function queuedAhead(jobs: OrderedJob[], exceptKey?: string): QueuedAhead {
  const own = exceptKey ? jobs.find((job) => job.key === exceptKey) : undefined;
  const ahead = jobs.filter(
    (job) => (!exceptKey || job.key !== exceptKey) && (!own || job.place < own.place),
  );
  const until = ahead.length > 0 ? new Date(Math.max(...ahead.map((job) => job.dueAt))) : null;
  return { until, own: own !== undefined };
}

/**
 * `RELEASE_FOLLOWERS_SQL` over jobs held in memory: the followers at the head, in their order,
 * up to the first job that is not one or is running; the job keyed `exceptKey` is left out.
 */
export function headFollowers<T extends OrderedJob>(jobs: T[], exceptKey?: string): T[] {
  const queued = jobs
    .filter((job) => job.key !== exceptKey || exceptKey === undefined)
    .toSorted((a, b) => a.dueAt - b.dueAt || a.place - b.place);
  const leader = queued.find((job) => job.running || !job.follower);
  return queued.filter(
    (job) => job.follower && !job.running && (!leader || job.dueAt < leader.dueAt),
  );
}
