import type {
  BackgroundJob,
  BackgroundJobHandlers,
  JobPublisher,
  JobWorkerHost,
} from "@rakazo/adapter-kit";
import { dispatchBackgroundJob } from "@rakazo/adapter-kit";
import { isTooManyDatabaseConnections } from "@rakazo/db";
import { getLogger, runCorrelatedJob, unwrapJobPayload, wrapJobPayload } from "@rakazo/logging";
import type { Runner, WorkerUtils } from "graphile-worker";
import { makeWorkerUtils, run } from "graphile-worker";
import type { Pool } from "pg";
import { recordHistoryCompactAttemptsExhausted } from "./history-compaction.js";

// Share the caller's pg.Pool instead of opening a separate connectionString-based
// pool per graphile-worker component: three independent pools per worker process
// (Prisma + publisher + runner) triples the connection footprint against Postgres'
// max_connections for no benefit, since they never need isolation from each other.
export class GraphileJobPublisher implements JobPublisher {
  private utils: Promise<WorkerUtils> | undefined;
  private closed = false;

  constructor(private readonly pgPool: Pool) {}

  async enqueue(job: BackgroundJob): Promise<void> {
    const utils = await this.getUtils();
    // replace resets attempts and run_at. unsafe_dedupe leaves both, so an
    // exhausted row would stay queued forever. Dedupe only while attempts remain.
    const jobKeyMode = await this.keepExistingMode(utils, job);
    await utils.addJob(job.name, wrapJobPayload(job.payload), {
      runAt: job.availableAt,
      jobKey: job.replaceKey,
      maxAttempts: job.maxAttempts,
      ...(jobKeyMode ? { jobKeyMode } : {}),
    });
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
      const found = await client.query<{ attempts: number; max_attempts: number }>(
        "select attempts, max_attempts from graphile_worker._private_jobs where key = $1",
        [key],
      );
      return found.rows[0];
    });
    if (!existing || Number(existing.attempts) >= Number(existing.max_attempts)) return undefined;
    return "unsafe_dedupe";
  }
}

/** Same bounded backoff the worker uses around jobHost.start for 53300. */
export function databaseCapacityBackoffMs(attempt: number): number {
  return Math.min(30_000, 200 * 2 ** Math.min(attempt, 8));
}

export class GraphileJobWorkerHost implements JobWorkerHost {
  private runner: Runner | undefined;
  private handlers: BackgroundJobHandlers | undefined;
  private stopping = false;
  private superviseTask: Promise<void> | undefined;
  private wakeSleep: (() => void) | undefined;

  constructor(
    private readonly pgPool: Pool,
    private readonly options: {
      concurrency?: number;
      pollInterval?: number;
      noHandleSignals?: boolean;
      /** Test seam: delay between 53300 restart attempts. */
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {}

  async start(handlers: BackgroundJobHandlers): Promise<void> {
    if (this.runner || this.superviseTask) return;
    this.stopping = false;
    this.handlers = handlers;
    await this.launchRunner();
    // run() resolves once the runner is up; runner.promise can still reject later
    // (e.g. Postgres 53300). Observe it so a dead runner cannot leave the worker
    // process idle forever while unhandledRejection swallows that same error.
    this.superviseTask = this.supervise();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wakeSleep?.();
    try {
      await this.runner?.stop();
    } finally {
      await this.superviseTask?.catch(() => undefined);
      this.runner = undefined;
      this.superviseTask = undefined;
      this.handlers = undefined;
    }
  }

  private async launchRunner(): Promise<void> {
    const handlers = this.handlers;
    if (!handlers) throw new Error("Background job worker has no handlers");
    const taskList = Object.fromEntries(
      Object.keys(handlers).map((name) => [
        name,
        async (payload: unknown) => {
          const unpacked = unwrapJobPayload(payload);
          await runCorrelatedJob({
            name,
            payload: unpacked.payload,
            correlation: unpacked.correlation,
            run: () => dispatchBackgroundJob(handlers, name, unpacked.payload),
          });
        },
      ]),
    );
    const runner = await run({
      pgPool: this.pgPool,
      concurrency: this.options.concurrency ?? 4,
      pollInterval: this.options.pollInterval ?? 500,
      noHandleSignals: this.options.noHandleSignals,
      taskList,
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
        if (!isTooManyDatabaseConnections(error)) throw error;
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
            if (!isTooManyDatabaseConnections(startError)) throw startError;
          }
        }
      }
    }
  }
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
      run: () => dispatchBackgroundJob(handlers, job.name, unpacked.payload),
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
