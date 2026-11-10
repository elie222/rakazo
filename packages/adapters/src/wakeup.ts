import { setTimeout as sleep } from "node:timers/promises";
import type {
  BackgroundJob,
  BackgroundJobExecution,
  BackgroundJobHandlers,
  BackgroundJobName,
  JobPublisher,
  JobWorkerHost,
} from "@rakazo/adapter-kit";
import { dispatchBackgroundJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { isPoolCheckoutTimeout, isTooManyDatabaseConnections, runAsSystem } from "@rakazo/db";
import { getLogger, runCorrelatedJob, unwrapJobPayload, wrapJobPayload } from "@rakazo/logging";
import type { JobHelpers, Runner, WorkerUtils } from "graphile-worker";
import { makeWorkerUtils, run } from "graphile-worker";
import type { Pool, PoolClient } from "pg";
import { recordHistoryCompactAttemptsExhausted } from "./history-compaction.js";
import { RunExecutionHost } from "./run-execution.js";

// Adapter-local task name: the shared job contract remains run.continue. Older
// publishers can keep publishing it while a new worker drains the legacy queue.
const INTERACTIVE_RUN_TASK = "run.interactive";
type RunLookup = Pick<PrismaClient, "run">;
type Workload = "interactive" | "background" | "maintenance";

async function isInteractiveRun(prisma: RunLookup, runId: string): Promise<boolean> {
  const run = await prisma.run.findUnique({ where: { id: runId }, select: { trigger: true } });
  return Boolean(
    run &&
      [
        "user",
        "follow_up",
        "reaction",
        "call_end",
        "messaging",
        "created",
        "skill",
        "resume",
      ].includes(run.trigger),
  );
}

// Share the caller's pg.Pool instead of opening a separate connectionString-based
// pool per graphile-worker component: three independent pools per worker process
// (Prisma + publisher + runner) triples the connection footprint against Postgres'
// max_connections for no benefit, since they never need isolation from each other.
export class GraphileJobPublisher implements JobPublisher {
  private utils: Promise<WorkerUtils> | undefined;
  private closed = false;

  constructor(
    private readonly pgPool: Pool,
    private readonly prisma?: RunLookup,
  ) {}

  async enqueue(job: BackgroundJob): Promise<void> {
    const utils = await this.getUtils();
    // replace resets attempts and run_at. unsafe_dedupe leaves both, so an
    // exhausted row would stay queued forever. Dedupe only while attempts remain,
    // and not a job locked by replaceLockedBefore: Graphile never unlocks a job
    // whose worker died, and replace detaches a locked job and inserts a new one.
    const jobKeyMode = await this.keepExistingMode(utils, job);
    const task =
      job.name === "run.continue" &&
      this.prisma &&
      (await isInteractiveRun(this.prisma, job.payload.runId))
        ? INTERACTIVE_RUN_TASK
        : job.name;
    await utils.addJob(task, wrapJobPayload(job.payload), {
      runAt: job.availableAt,
      jobKey: job.replaceKey,
      maxAttempts: job.maxAttempts,
      ...(jobKeyMode ? { jobKeyMode } : {}),
    });
    if (
      task === INTERACTIVE_RUN_TASK &&
      jobKeyMode === "unsafe_dedupe" &&
      job.name === "run.continue"
    ) {
      // unsafe_dedupe preserves the old task identifier too. Move a legacy job
      // without resetting its retry budget, backoff, payload, or correlation.
      // Never move a locked job out from under the worker already processing it.
      await utils.withPgClient((client) =>
        client.query(
          `update graphile_worker._private_jobs as jobs
           set task_id = target.id
           from graphile_worker._private_tasks as target,
                graphile_worker._private_tasks as previous
           where jobs.key = $1 and jobs.locked_at is null
             and jobs.task_id = previous.id and previous.identifier = 'run.continue'
             and target.identifier = $2
             and coalesce(jobs.payload->>'runId', jobs.payload->'payload'->>'runId') = $3`,
          [job.replaceKey, INTERACTIVE_RUN_TASK, job.payload.runId],
        ),
      );
    }
  }

  async cancel(key: string): Promise<void> {
    const utils = await this.getUtils();
    await utils.withPgClient(async (client) => {
      await client.query("select graphile_worker.remove_job($1::text)", [key]);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.utils) await (await this.utils).release();
  }

  private getUtils(): Promise<WorkerUtils> {
    if (this.closed) throw new Error("Background job publisher is closed");
    this.utils ??= makeWorkerUtils({ pgPool: this.pgPool });
    return this.utils;
  }

  private async keepExistingMode(
    utils: WorkerUtils,
    job: BackgroundJob,
  ): Promise<"unsafe_dedupe" | undefined> {
    const key = job.replaceKey;
    if (!job.keepExisting || !key) return undefined;
    const existing = await utils.withPgClient(async (client) => {
      const found = await client.query<{
        attempts: number;
        max_attempts: number;
        locked_at: Date | null;
      }>(
        "select attempts, max_attempts, locked_at from graphile_worker._private_jobs where key = $1",
        [key],
      );
      return found.rows[0];
    });
    if (!existing) return undefined;
    const lockedAt = existing.locked_at;
    if (lockedAt && job.replaceLockedBefore && lockedAt <= job.replaceLockedBefore)
      return undefined;
    if (Number(existing.attempts) >= Number(existing.max_attempts)) return undefined;
    return "unsafe_dedupe";
  }
}

/**
 * Job payloads carry only ids. Dispatch starts as system rather than inheriting
 * whichever request enqueued the job (the in-memory queue's timers would otherwise
 * keep its tenant); each handler then narrows to the tenant of the row it acts for
 * (see createBackgroundJobHandlers).
 */
function dispatchJob(
  handlers: BackgroundJobHandlers,
  name: string,
  payload: unknown,
  execution?: BackgroundJobExecution,
) {
  return runAsSystem(`background job ${name}`, () =>
    dispatchBackgroundJob(handlers, name, payload, execution),
  );
}

/**
 * Install or upgrade graphile-worker's schema. Runs as the migration role during
 * `pnpm db:migrate`, so the runtime role only needs grants on that schema.
 */
export async function migrateJobQueue(connectionString: string): Promise<void> {
  const utils = await makeWorkerUtils({ connectionString });
  try {
    await utils.migrate();
  } finally {
    await utils.release();
  }
}

/** Same bounded backoff the worker uses around jobHost.start for 53300. */
export function databaseCapacityBackoffMs(attempt: number): number {
  return Math.min(30_000, 200 * 2 ** Math.min(attempt, 8));
}

/**
 * Saturation a relaunch rides out. A job's completion that cannot get a connection for long
 * enough stops the runner with pg-pool's checkout timeout, which the worker process otherwise
 * ignores, so it would stay up without one.
 */
function isDatabaseSaturated(error: unknown): boolean {
  return isTooManyDatabaseConnections(error) || isPoolCheckoutTimeout(error);
}

function abandonment() {
  let reject!: (error: Error) => void;
  const promise = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  promise.catch(() => undefined);
  const state = {
    promise,
    /** Read synchronously, so a late delivery is refused before its handler starts. */
    abandoned: false,
    abandon() {
      state.abandoned = true;
      reject(new Error("The worker stopped before this job finished"));
    },
  };
  return state;
}

/**
 * Graphile writes a job's completion or failure as one prepared statement per
 * batch: complete_job, complete_jobs or complete_job_q for completions, fail_job,
 * fail_job_q or fail_jobs for failures, each suffixed /{schema} (dist/sql/
 * completeJobs.js and dist/sql/failJobs.js of graphile-worker 0.18.0). Claims,
 * lock resets and the notify listener use other statement names, and this
 * repository's own queue statements are unnamed, so these prefixes identify
 * exactly the job writes. An unrecognised shape yields no ids, which reads as a
 * write that has not landed yet.
 */
function jobWriteJobIds(config: unknown): string[] | undefined {
  if (typeof config !== "object" || config === null) return undefined;
  const { name, values } = config as { name?: unknown; values?: unknown };
  if (typeof name !== "string" || !Array.isArray(values)) return undefined;
  if (name.startsWith("fail_job/") || name.startsWith("fail_job_q/")) {
    // values: [poolId, json array of {jobId, message, payload} entries].
    if (typeof values[1] !== "string") return undefined;
    let specs: unknown;
    try {
      specs = JSON.parse(values[1]);
    } catch {
      return undefined;
    }
    if (!Array.isArray(specs)) return undefined;
    return specs.every((spec) => isJobId((spec as { jobId?: unknown } | null)?.jobId))
      ? specs.map((spec) => String((spec as { jobId: unknown }).jobId))
      : undefined;
  }
  // Complete statements pass one id or the id array first; fail_jobs the id array.
  if (
    name.startsWith("complete_job/") ||
    name.startsWith("complete_jobs/") ||
    name.startsWith("complete_job_q/") ||
    name.startsWith("fail_jobs/")
  ) {
    const ids = Array.isArray(values[0]) ? values[0] : [values[0]];
    return ids.every(isJobId) ? ids.map((id) => String(id)) : undefined;
  }
  return undefined;
}

function isJobId(id: unknown): boolean {
  return typeof id === "string" || typeof id === "number";
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

/**
 * The pool the runner gets, so the host learns the moment Graphile's job writes
 * become durable: a write's statement resolving through a checked-out client
 * means the jobs it carries have settled in the database. Everything else,
 * including pg-pool's internal callback-form checkouts (pool.query, the notify
 * listener), passes through untouched.
 */
function poolObservingJobWrites(
  pool: Pool,
  onWritesLanded: (ids: readonly string[]) => void,
): Pool {
  return new Proxy(pool, {
    get(target, property) {
      if (property === "connect") {
        return (...args: unknown[]) => {
          const checkout = target.connect.bind(target) as (...a: unknown[]) => unknown;
          if (typeof args[0] === "function") return checkout(...args);
          return (checkout() as Promise<PoolClient>).then((client) =>
            clientObservingJobWrites(client, onWritesLanded),
          );
        };
      }
      return delegate(target, property);
    },
  });
}

function clientObservingJobWrites(
  client: PoolClient,
  onWritesLanded: (ids: readonly string[]) => void,
): PoolClient {
  return new Proxy(client, {
    get(target, property) {
      if (property === "query") {
        return (config: unknown, ...rest: unknown[]) => {
          const ids = jobWriteJobIds(config);
          const query = target.query.bind(target) as (...args: unknown[]) => unknown;
          const result = query(config, ...rest);
          // Only a resolved statement has landed; a failed one retries, and its
          // ids must stay owed until a retry succeeds.
          if (ids !== undefined && isPromiseLike(result)) {
            void Promise.resolve(result).then(
              () => onWritesLanded(ids),
              () => undefined,
            );
          }
          return result;
        };
      }
      return delegate(client, property);
    },
  });
}

function delegate(target: object, property: string | symbol): unknown {
  const value = Reflect.get(target, property, target);
  return typeof value === "function"
    ? (value as (...args: unknown[]) => unknown).bind(target)
    : value;
}

/**
 * How long a stopping worker lets its running jobs finish. The slowest job is a computer sleep that
 * saves the home; on Boat its own timeouts (a 9-minute archive, then a 30-minute download) fit
 * inside. Other providers bound each request but not a whole save, so a longer one is cut off as
 * if the worker had crashed: its suspend claim keeps the retried job from starting a second save,
 * and the idle sweep sleeps the computer once the claim is ABANDONED_SUSPEND_CLAIM_MS old. Stays
 * below the worker's stop_grace_period in Compose, and below that claim age so the sweep never
 * replaces a sleep that is still draining.
 */
export const JOB_DRAIN_TIMEOUT_MS = 45 * 60_000;

/**
 * How long a worker with nothing running waits for Graphile's own shutdown — unlistening,
 * joining in-flight polls, flushing job writes — before exiting without it. No work is worth
 * waiting for at that point, so a database that does not answer must not hold the worker,
 * and with it the container's stop grace period, open until Docker kills it. Applies only to
 * confirmed idle housekeeping: while any job ran or still owes its completion write, the
 * drain deadline bounds the wait instead.
 */
const IDLE_JOB_STOP_TIMEOUT_MS = 10_000;

export class GraphileJobWorkerHost implements JobWorkerHost {
  private runner: Runner | undefined;
  private handlers: BackgroundJobHandlers | undefined;
  private stopping = false;
  private superviseTask: Promise<void> | undefined;
  private wakeSleep: (() => void) | undefined;
  private readonly executions = new RunExecutionHost();
  private readonly running = new Set<{ name: BackgroundJobName }>();
  /** Jobs whose completion or failure write Graphile has not landed yet. */
  private readonly owedWrites = new Set<string>();
  /** Set while stopping: re-arms the stop deadline when outstanding work changes. */
  private rearmStopDeadline: (() => void) | undefined;
  /** Rejects once the drain deadline passes, failing every job still running. */
  private abandoned = abandonment();
  /** Set while stopping: tells stop() about a claim racing the pool's deactivation. */
  private claimedWhileStopping: (() => void) | undefined;
  private readonly runnerPool: Pool;

  constructor(
    pgPool: Pool,
    private readonly options: {
      concurrency?: number;
      pollInterval?: number;
      /** Fetch due jobs in batches so idle slots share one poll instead of each polling. */
      localQueueSize?: number;
      /** Omit for a worker that handles every task (tests and embedded hosts). */
      workload?: Workload;
      /** Test seam: delay between 53300 restart attempts. */
      sleep?: (ms: number) => Promise<void>;
      /** Test seam for JOB_DRAIN_TIMEOUT_MS. */
      drainTimeoutMs?: number;
      /** Test seam for the idle stop bound. */
      idleStopTimeoutMs?: number;
    } = {},
  ) {
    this.runnerPool = poolObservingJobWrites(pgPool, (ids) => this.noteWritesLanded(ids));
  }

  async start(handlers: BackgroundJobHandlers): Promise<void> {
    if (this.runner || this.superviseTask) return;
    this.stopping = false;
    this.executions.start();
    this.abandoned = abandonment();
    this.owedWrites.clear();
    this.handlers = handlers;
    await this.launchRunner();
    // run() resolves once the runner is up; runner.promise can still reject later
    // (e.g. Postgres 53300). Observe it so a dead runner cannot leave the worker
    // process idle forever while unhandledRejection swallows that same error.
    this.superviseTask = this.supervise();
  }

  /**
   * Graphile stops claiming jobs and waits for the running ones to finish. Killing the process
   * instead would leave each one locked for Graphile's four hours before anything retries it.
   * Past the deadline a job is hung: it fails, which unlocks it with the usual backoff, so another
   * worker retries it within seconds. A handed-off run that outlives it is left to the
   * reconciler, as after a crash. The runner's own shutdown waits for every handler and for the
   * completion writes Graphile still owes the database, so while any job ran — interactive,
   * background or maintenance, including a claim racing the pool's deactivation — or still
   * owes its write, which the wrapped runner pool reports, only the drain deadline may bound
   * that wait. Once no work and no write is outstanding, only housekeeping remains, and the
   * deadline collapses to the short idle bound, so a database that does not answer cannot
   * hold the worker, and with it the container's stop grace period, open until Docker kills it.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wakeSleep?.();
    const draining = this.executions.stop();
    const started = Date.now();
    const busy = this.busy();
    const idleMs = this.options.idleStopTimeoutMs ?? IDLE_JOB_STOP_TIMEOUT_MS;
    const drainMs = this.options.drainTimeoutMs ?? JOB_DRAIN_TIMEOUT_MS;
    // A callback that outlives this stop may only ever reach this session's abandonment.
    const session = this.abandoned;
    if (busy) getLogger().info("jobs.draining", this.runningBindings());
    const abandon = (timedOut: "jobs.drain_timed_out" | "jobs.stop_timed_out") => {
      getLogger().warn(timedOut, this.runningBindings());
      session.abandon();
    };
    // The deadline tracks the outstanding work: the drain bound while a job runs or
    // owes its write, the idle bound once neither remains, re-armed on every change
    // until this stop returns.
    let armedBusy = busy;
    let finished = false;
    let deadline = setTimeout(
      () => abandon(armedBusy ? "jobs.drain_timed_out" : "jobs.stop_timed_out"),
      armedBusy ? drainMs : idleMs,
    );
    const rearmDeadline = () => {
      const nowBusy = this.busy();
      if (finished || nowBusy === armedBusy) return;
      armedBusy = nowBusy;
      clearTimeout(deadline);
      deadline = setTimeout(
        () => abandon(nowBusy ? "jobs.drain_timed_out" : "jobs.stop_timed_out"),
        nowBusy ? drainMs : idleMs,
      );
    };
    this.rearmStopDeadline = rearmDeadline;
    // A handed-off run outliving its job is the last work the drain bound is for;
    // once it finishes, the deadline may collapse for the remaining housekeeping.
    void draining.catch(() => undefined).then(() => rearmDeadline());
    // A job claimed while the runner's stop deactivates the pool is work like any other:
    // its handler and its completion write deserve the drain bound, not the idle bound.
    // Each claim re-arms the deadline: an earlier one may already have settled and let it
    // collapse to the idle bound. Only the first claim is logged.
    let ranSinceStop = false;
    this.claimedWhileStopping = () => {
      if (!ranSinceStop) getLogger().info("jobs.draining", this.runningBindings());
      ranSinceStop = true;
      rearmDeadline();
    };
    const abandoned = session.promise.catch(() => undefined);
    try {
      // runner.stop() returns at once when Graphile already began its own shutdown (a
      // breaking migration notice, a fatal job write), and during a relaunch there is no
      // runner yet. The supervise loop settles only once the current runner's promise does,
      // which waits for every job that runner claimed, so the stop waits for both.
      const runnerStop = Promise.all([
        this.runner?.stop(),
        this.superviseTask?.catch(() => undefined),
      ]);
      const drained = await Promise.race([
        runnerStop.then(() => true as const),
        abandoned.then(() => false as const),
      ]);
      // The deadline failed the still-running handlers. Their failure writes are what
      // unlocks those jobs for another worker, so when work ran, give the writes the
      // idle bound to land before leaving them to the same paths as a crash.
      if (!drained && (busy || ranSinceStop)) {
        await Promise.race([runnerStop.catch(() => undefined), sleep(idleMs)]);
      }
    } finally {
      this.claimedWhileStopping = undefined;
      this.rearmStopDeadline = undefined;
      // The queue has stopped accepting deliveries. Handed-off runs still own
      // leases and must finish before their database and providers are closed.
      await Promise.race([draining, abandoned]);
      finished = true;
      clearTimeout(deadline);
      this.runner = undefined;
      this.superviseTask = undefined;
      this.handlers = undefined;
    }
    if (busy) getLogger().info("jobs.drained", { "jobs.drain_ms": Date.now() - started });
  }

  /** Work whose loss would leave a job locked or a run unfinished. */
  private busy(): boolean {
    return this.running.size > 0 || this.executions.activeCount > 0 || this.owedWrites.size > 0;
  }

  private noteWritesLanded(ids: readonly string[]): void {
    let removed = false;
    for (const id of ids) {
      if (this.owedWrites.delete(id)) removed = true;
    }
    if (removed) this.rearmStopDeadline?.();
  }

  private runningBindings() {
    const names = [...this.running].map((job) => job.name);
    return {
      "jobs.running": names.length,
      "jobs.types": [...new Set(names)].sort().join(","),
      "runs.active": this.executions.activeCount,
    };
  }

  private async launchRunner(): Promise<void> {
    const handlers = this.handlers;
    if (!handlers) throw new Error("Background job worker has no handlers");
    const abandoned = this.abandoned;
    const taskList = Object.fromEntries(
      (Object.keys(handlers) as BackgroundJobName[])
        .filter((name) => {
          if (this.options.workload === "maintenance") return name !== "run.continue";
          if (this.options.workload) return name === "run.continue";
          return true;
        })
        .map((name) => [
          this.options.workload === "interactive" ? INTERACTIVE_RUN_TASK : name,
          async (payload: unknown, helpers: JobHelpers) => {
            // A claim that returns after the stop gave up on this runner must not start:
            // Graphile fails the job at once, and a retry elsewhere would overlap its handler.
            if (abandoned.abandoned) throw new Error("The worker stopped before this job started");
            const unpacked = unwrapJobPayload(payload);
            const execute = (execution?: BackgroundJobExecution) =>
              runCorrelatedJob({
                name,
                payload: unpacked.payload,
                correlation: unpacked.correlation,
                run: () => dispatchJob(handlers, name, unpacked.payload, execution),
              });
            const job = { name };
            this.running.add(job);
            if (this.stopping) this.claimedWhileStopping?.();
            try {
              const work = name === "run.continue" ? this.executions.execute(execute) : execute();
              // An abandoned job may still settle; the process exits soon after.
              work.catch(() => undefined);
              await Promise.race([work, abandoned.promise]);
            } finally {
              this.running.delete(job);
              // Graphile queues this job's completion or failure write the moment
              // this wrapper settles; it lands through the wrapped runner pool.
              this.owedWrites.add(helpers.job.id);
            }
          },
        ]),
    );
    if (!this.options.workload) taskList[INTERACTIVE_RUN_TASK] = taskList["run.continue"]!;
    const runner = await run({
      pgPool: this.runnerPool,
      concurrency: this.options.concurrency ?? 4,
      pollInterval: this.options.pollInterval ?? 500,
      // Graphile kills the process by re-raising SIGTERM once its own jobs stop, before the
      // host's shutdown has handed back the runs it executes outside Graphile.
      noHandleSignals: true,
      taskList,
      preset: {
        worker: {
          // Batched, Graphile's shutdown waits for these writes; unbatched, it fires them and
          // returns, so a worker exiting right after could leave its jobs locked for hours.
          completeJobBatchDelay: 0,
          failJobBatchDelay: 0,
          // The wrapped runner pool recognises job writes by their prepared-statement
          // names, which this option keeps present.
          preparedStatements: true,
          ...(this.options.localQueueSize
            ? { localQueue: { size: this.options.localQueueSize } }
            : {}),
        },
      },
    });
    runner.events.on("job:failed", ({ job, error }) => {
      recordHistoryCompactAttemptsExhausted(job, error);
    });
    if (this.stopping) {
      await runner.stop().catch(() => undefined);
      return;
    }
    this.runner = runner;
  }

  private delay(ms: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const sleep =
      this.options.sleep ??
      ((wait: number) => new Promise<void>((resolve) => setTimeout(resolve, wait)));
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.wakeSleep = undefined;
        resolve();
      };
      this.wakeSleep = finish;
      void Promise.resolve(sleep(ms)).then(finish, finish);
    });
  }

  private async supervise(): Promise<void> {
    for (;;) {
      const runner = this.runner;
      if (!runner || this.stopping) return;
      try {
        await runner.promise;
        return;
      } catch (error) {
        if (this.stopping) return;
        if (this.runner === runner) this.runner = undefined;
        if (!isDatabaseSaturated(error)) throw error;
        // Back off after every lifecycle 53300 (runner death or failed relaunch),
        // not only when launchRunner rejects — otherwise a runner that starts then
        // dies again under saturation reconnects with no delay.
        for (let attempt = 0; ; attempt += 1) {
          if (this.stopping) return;
          await this.delay(databaseCapacityBackoffMs(attempt));
          if (this.stopping) return;
          try {
            await this.launchRunner();
            if (this.stopping || !this.runner) return;
            break;
          } catch (startError) {
            if (!isDatabaseSaturated(startError)) throw startError;
          }
        }
      }
    }
  }
}

/**
 * Scheduled and maintenance jobs mostly wait on the network, so each starts as soon as it
 * is due. A slow job only occupies its own slot; per-entity safety comes from job keys
 * and row claims, never from running jobs one at a time.
 */
const MAINTENANCE_JOB_CONCURRENCY = 100;
const MAINTENANCE_LOCAL_QUEUE_SIZE = 10;

/** Long agent turns cannot occupy the capacity reserved for other workloads. */
export function createReservedGraphileJobWorkerHost(
  pool: Pool,
  options: { concurrency?: number; pollInterval?: number } = {},
): JobWorkerHost {
  const hosts = (["interactive", "background", "maintenance"] as const).map(
    (workload) =>
      new GraphileJobWorkerHost(pool, {
        ...options,
        ...(workload === "maintenance"
          ? {
              concurrency: MAINTENANCE_JOB_CONCURRENCY,
              localQueueSize: MAINTENANCE_LOCAL_QUEUE_SIZE,
            }
          : { concurrency: workload === "interactive" ? options.concurrency : 1 }),
        workload,
      }),
  );
  let stopping = false;
  const stop = async () => {
    stopping = true;
    const results = await Promise.allSettled(hosts.map((host) => host.stop()));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  };
  return {
    async start(handlers) {
      stopping = false;
      try {
        // Legacy jobs that are already locked finish with their original queue
        // identity and retry accounting. Reconciliation promotes unlocked chat.
        for (const host of hosts) {
          if (stopping) break;
          await host.start(handlers);
        }
      } catch (error) {
        await stop();
        throw error;
      }
    },
    stop,
  };
}

/** Exhausted retry rows are durable notice requests, including across worker restarts. */
export function createRoutineRetryNoticeReconciler(
  pool: Pool,
  notify: (runId: string) => Promise<void>,
): () => Promise<void> {
  const batchSize = 20;
  const concurrency = 4;
  let cursor = "0";
  return async () => {
    const { rows } = await pool.query<{ id: string; revision: number; payload: unknown }>(
      `select jobs.id, jobs.revision, jobs.payload
       from graphile_worker._private_jobs as jobs
       join graphile_worker._private_tasks as tasks on tasks.id = jobs.task_id
       where tasks.identifier = 'routine.retry'
         and jobs.attempts >= jobs.max_attempts and jobs.locked_at is null
         and jobs.id > $1::bigint
       order by jobs.id limit $2`,
      [cursor, batchSize],
    );
    const deliver = async (job: (typeof rows)[number]) => {
      const { payload } = unwrapJobPayload(job.payload);
      if (
        !payload ||
        typeof payload !== "object" ||
        !("runId" in payload) ||
        typeof payload.runId !== "string" ||
        !payload.runId
      ) {
        return;
      }
      try {
        await notify(payload.runId);
        // A concurrently replaced job is new work, not the notice we just delivered.
        // A crash before this delete may replay the notice (at-least-once delivery).
        await pool.query(
          `delete from graphile_worker._private_jobs
           where id = $1 and revision = $2
             and attempts >= max_attempts and locked_at is null`,
          [job.id, job.revision],
        );
      } catch (error) {
        getLogger().error("routine retry exhaustion notification", error);
      }
    };
    for (let index = 0; index < rows.length; index += concurrency) {
      await Promise.all(rows.slice(index, index + concurrency).map(deliver));
    }
    // Advance past failures too, so an unavailable destination cannot starve later notices.
    // Wrap after the final page; failed rows stay durable and will be revisited.
    cursor = rows.length === batchSize ? rows[rows.length - 1]!.id : "0";
  };
}

export const DEAD_JOB_RETENTION_DAYS = 7;
const DEAD_JOB_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DEAD_JOB_PRUNE_BATCH = 1_000;
const DEAD_JOB_PRUNE_MAX_BATCHES = 50;

/**
 * Graphile keeps a job that exhausted its retries forever, and its own maintenance scans them.
 * Delete them once they are old enough that nobody is still diagnosing the failure. Exhausted
 * `routine.retry` rows are notice requests, which their reconciler deletes after delivery.
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
    const now = Date.now();
    if (lastRun !== undefined && now - lastRun < intervalMs) return;
    lastRun = now;
    let removed = 0;
    for (let batch = 0; batch < DEAD_JOB_PRUNE_MAX_BATCHES; batch += 1) {
      const { rowCount } = await pool.query(
        `delete from graphile_worker._private_jobs as jobs
         where jobs.id in (
           select dead.id
           from graphile_worker._private_jobs as dead
           join graphile_worker._private_tasks as tasks on tasks.id = dead.task_id
           where dead.attempts >= dead.max_attempts and dead.locked_at is null
             and dead.updated_at < now() - make_interval(days => $1::int)
             and tasks.identifier <> 'routine.retry'
           order by dead.id
           limit $2
           for update of dead skip locked
         )
         and jobs.attempts >= jobs.max_attempts and jobs.locked_at is null`,
        [retentionDays, DEAD_JOB_PRUNE_BATCH],
      );
      removed += rowCount ?? 0;
      if ((rowCount ?? 0) < DEAD_JOB_PRUNE_BATCH) break;
    }
    if (removed > 0) getLogger().info("jobs.dead_pruned", { "jobs.removed": removed });
  };
}

/** Graphile's default when a job sets no cap. */
const DEFAULT_JOB_MAX_ATTEMPTS = 25;

interface QueuedJob {
  name: BackgroundJob["name"];
  payload: unknown;
  availableAt?: Date;
  replaceKey?: string;
  attempts: number;
  maxAttempts: number;
}

function toQueuedJob(job: BackgroundJob): QueuedJob {
  return {
    name: job.name,
    payload: wrapJobPayload(job.payload),
    availableAt: job.availableAt,
    replaceKey: job.replaceKey,
    attempts: 0,
    maxAttempts: job.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS,
  };
}

export class InMemoryJobQueue implements JobPublisher, JobWorkerHost {
  private handlers: BackgroundJobHandlers | undefined;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly scheduled = new Map<ReturnType<typeof setTimeout>, QueuedJob>();
  private readonly keyed = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly active = new Set<Promise<void>>();
  private readonly failures = new Map<BackgroundJob["name"], number>();
  private readonly closingJobs: QueuedJob[] = [];
  private draining: Promise<void> | undefined;
  private closed = false;
  private stopped = false;
  private closing = false;
  private acceptingClosingJobs = false;
  private closeRequested = false;

  async enqueue(job: BackgroundJob): Promise<void> {
    const stored = toQueuedJob(job);
    if (this.closed) throw new Error("Background job publisher is closed");
    if (this.stopped) throw new Error("Background job publisher is stopped");
    // Keep a keyed job only while attempts remain. An exhausted row stays
    // queued in Graphile and would never run again under unsafe_dedupe.
    const existing = this.existingJob(stored.replaceKey);
    if (job.keepExisting && existing && existing.attempts < existing.maxAttempts) {
      return;
    }
    if (this.closing) {
      this.enqueueWhileClosing(stored);
      return;
    }
    if (stored.replaceKey) {
      await this.cancel(stored.replaceKey);
      if (this.closed) throw new Error("Background job publisher is closed");
      if (this.stopped) throw new Error("Background job publisher is stopped");
      if (this.closing) {
        this.enqueueWhileClosing(stored);
        return;
      }
    }
    const delay = stored.availableAt ? Math.max(0, stored.availableAt.getTime() - Date.now()) : 0;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.scheduled.delete(timer);
      if (stored.replaceKey && this.keyed.get(stored.replaceKey) === timer) {
        this.keyed.delete(stored.replaceKey);
      }
      const handlers = this.handlers;
      if (!handlers) return;
      void this.dispatch(handlers, stored);
    }, delay);
    this.timers.add(timer);
    this.scheduled.set(timer, stored);
    if (stored.replaceKey) this.keyed.set(stored.replaceKey, timer);
  }

  async cancel(replaceKey: string): Promise<void> {
    const closing = this.closingJobs.findIndex((job) => job.replaceKey === replaceKey);
    if (closing >= 0) this.closingJobs.splice(closing, 1);
    const timer = this.keyed.get(replaceKey);
    if (!timer) return;
    clearTimeout(timer);
    this.keyed.delete(replaceKey);
    this.timers.delete(timer);
    this.scheduled.delete(timer);
  }

  /** Attempts and schedule for a keyed job that is still queued. */
  keyedJob(
    replaceKey: string,
  ): { attempts: number; maxAttempts: number; availableAt?: Date } | undefined {
    const job = this.existingJob(replaceKey);
    if (!job) return undefined;
    return {
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      availableAt: job.availableAt ? new Date(job.availableAt.getTime()) : undefined,
    };
  }

  /** Count one failed attempt on a keyed job that is still queued. */
  recordFailedAttempt(replaceKey: string): void {
    const job = this.existingJob(replaceKey);
    if (!job) throw new Error("No keyed background job");
    job.attempts += 1;
  }

  private existingJob(replaceKey: string | undefined): QueuedJob | undefined {
    if (!replaceKey) return undefined;
    const timer = this.keyed.get(replaceKey);
    const scheduled = timer ? this.scheduled.get(timer) : undefined;
    if (scheduled) return scheduled;
    return this.closingJobs.find((queued) => queued.replaceKey === replaceKey);
  }

  async start(handlers: BackgroundJobHandlers): Promise<void> {
    this.handlers = handlers;
    this.stopped = false;
  }

  async stop(): Promise<void> {
    await this.drain();
  }

  /** Wait for due work and its immediate descendants without closing the queue. */
  async awaitIdle(): Promise<void> {
    for (;;) {
      const handlers = this.handlers;
      if (!handlers) return;
      for (const [timer, job] of this.scheduled) {
        if (job.availableAt && job.availableAt.getTime() > Date.now()) continue;
        clearTimeout(timer);
        this.timers.delete(timer);
        this.scheduled.delete(timer);
        if (job.replaceKey && this.keyed.get(job.replaceKey) === timer) {
          this.keyed.delete(job.replaceKey);
        }
        void this.dispatch(handlers, job);
      }
      if (this.active.size === 0) return;
      await Promise.all([...this.active]);
    }
  }

  /** Payloads and error text remain private; verification can inspect failed job kinds. */
  failureCounts(): Array<{ name: BackgroundJob["name"]; count: number }> {
    return [...this.failures].map(([name, count]) => ({ name, count }));
  }

  private dispatch(handlers: BackgroundJobHandlers, job: QueuedJob): Promise<void> {
    const unpacked = unwrapJobPayload(job.payload);
    const active = runCorrelatedJob({
      name: job.name,
      payload: unpacked.payload,
      correlation: unpacked.correlation,
      run: () => dispatchJob(handlers, job.name, unpacked.payload),
    }).catch(() => {
      this.failures.set(job.name, (this.failures.get(job.name) ?? 0) + 1);
    });
    this.active.add(active);
    void active.finally(() => this.active.delete(active));
    return active;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closeRequested = true;
    await this.drain();
  }

  private enqueueWhileClosing(job: QueuedJob): void {
    if (job.replaceKey) {
      const existing = this.closingJobs.findIndex((queued) => queued.replaceKey === job.replaceKey);
      if (existing >= 0) this.closingJobs.splice(existing, 1);
    }
    if (job.availableAt && job.availableAt.getTime() > Date.now()) {
      // Delayed in-memory jobs are intentionally discarded on shutdown; durable
      // schedulers reconcile them after restart. Never run them early.
      return;
    }
    if (!this.acceptingClosingJobs) throw new Error("Background job publisher is closing");
    this.closingJobs.push(job);
  }

  private async drain(): Promise<void> {
    if (this.draining) return this.draining;
    const draining = this.performDrain();
    this.draining = draining;
    try {
      await draining;
    } finally {
      if (this.draining === draining) this.draining = undefined;
    }
  }

  private async performDrain(): Promise<void> {
    this.closing = true;
    this.acceptingClosingJobs = true;
    for (const timer of this.timers) {
      clearTimeout(timer);
      const job = this.scheduled.get(timer);
      if (job) this.enqueueWhileClosing(job);
    }
    this.timers.clear();
    this.scheduled.clear();
    this.keyed.clear();
    await Promise.all(this.active);
    this.acceptingClosingJobs = false;
    const handlers = this.handlers;
    const closingJobs = this.closingJobs.splice(0);
    if (!handlers && closingJobs.length > 0) {
      throw new Error("Background job publisher is closing");
    }
    if (handlers) {
      for (const job of closingJobs) void this.dispatch(handlers, job);
    }
    await Promise.all(this.active);
    this.handlers = undefined;
    this.closed = this.closeRequested;
    this.stopped = !this.closeRequested;
    this.closing = false;
  }
}
