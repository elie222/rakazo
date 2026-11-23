import type {
  BackgroundJob,
  BackgroundJobAttempt,
  BackgroundJobExecution,
  BackgroundJobHandlers,
  JobPublisher,
  JobQueueOrder,
  JobTransaction,
  JobWorkerHost,
  QueuedAhead,
} from "@rakazo/adapter-kit";
import { dispatchBackgroundJob } from "@rakazo/adapter-kit";
import { runAsSystem } from "@rakazo/db";
import { runCorrelatedJob, unwrapJobPayload, wrapJobPayload } from "@rakazo/logging";
import type { OrderedJob } from "./named-queue-order.js";
import { headFollowers, isFollowerPayload, queuedAhead } from "./named-queue-order.js";

/**
 * Job payloads carry only ids. Dispatch starts as system rather than inheriting
 * whichever request enqueued the job (the in-memory queue's timers would otherwise
 * keep its tenant); each handler then narrows to the tenant of the row it acts for
 * (see createBackgroundJobHandlers).
 */
export function dispatchJob(
  handlers: BackgroundJobHandlers,
  name: string,
  payload: unknown,
  execution?: BackgroundJobExecution,
  attempt?: BackgroundJobAttempt,
) {
  return runAsSystem(`background job ${name}`, () =>
    dispatchBackgroundJob(handlers, name, payload, execution, attempt),
  );
}

const LAST_ATTEMPT = { number: 1, max: 1 } as const;

/** Graphile's default when a job sets no cap. */
const DEFAULT_JOB_MAX_ATTEMPTS = 25;

interface QueuedJob {
  name: BackgroundJob["name"];
  payload: unknown;
  availableAt?: Date;
  replaceKey?: string;
  queueName?: string;
  /** Its place in the queue, kept when it is replaced, as Graphile keeps a job's id. */
  place: number;
  ended?: boolean;
  attempts: number;
  maxAttempts: number;
}

function toQueuedJob(job: BackgroundJob): QueuedJob {
  return {
    name: job.name,
    payload: wrapJobPayload(job.payload),
    availableAt: job.availableAt,
    replaceKey: job.replaceKey,
    queueName: job.queueName,
    place: 0,
    attempts: 0,
    maxAttempts: job.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS,
  };
}

export class InMemoryJobQueue implements JobPublisher, JobQueueOrder, JobWorkerHost {
  private handlers: BackgroundJobHandlers | undefined;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly scheduled = new Map<ReturnType<typeof setTimeout>, QueuedJob>();
  private readonly keyed = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly active = new Set<Promise<void>>();
  private readonly running = new Set<QueuedJob>();
  private places = 0;
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
    if (!existing) this.places += 1;
    stored.place = existing?.place ?? this.places;
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
    this.schedule(stored);
  }

  private schedule(stored: QueuedJob): void {
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

  /** Not transactional: a job whose transaction rolls back still runs, and finds nothing to do. */
  async enqueueIn(_tx: JobTransaction, job: BackgroundJob): Promise<void> {
    await this.enqueue(job);
  }

  async enqueueManyIn(_tx: JobTransaction, jobs: readonly BackgroundJob[]): Promise<void> {
    for (const job of jobs) await this.enqueue(job);
  }

  /**
   * Not transactional either, so the job stays and runs when due, finding nothing to do, and a
   * rollback never loses a backup still needed. Marked ended, it holds its named queue back no more.
   */
  async cancelIn(_tx: JobTransaction, replaceKey: string): Promise<void> {
    const job = this.existingJob(replaceKey);
    if (job) job.ended = true;
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

  /** Like Graphile's: jobs scheduled, waiting out a shutdown or running count; a running one is due now. */
  async pendingUntil(queueName: string, exceptKey?: string): Promise<QueuedAhead> {
    return queuedAhead(this.ordered(queueName), exceptKey);
  }

  /** Like Graphile's, though not transactional: the followers move as soon as this is called. */
  async releaseFollowersIn(_tx: JobTransaction, queueName: string, exceptKey?: string) {
    const head = headFollowers(this.ordered(queueName), exceptKey);
    for (const [place, { timer, job, dueAt }] of head.entries()) {
      if (!timer) continue;
      clearTimeout(timer);
      this.timers.delete(timer);
      this.scheduled.delete(timer);
      if (job.replaceKey) this.keyed.delete(job.replaceKey);
      this.schedule({ ...job, availableAt: new Date(Math.min(dueAt, Date.now() + place)) });
    }
  }

  /** The queue's unfinished jobs, in the shape the queue-order rules read. */
  private ordered(queueName: string) {
    const now = Date.now();
    const of = (job: QueuedJob, running: boolean, timer?: ReturnType<typeof setTimeout>) => {
      const follower = isFollowerPayload(unwrapJobPayload(job.payload).payload);
      const dueAt = running ? now : (job.availableAt?.getTime() ?? now);
      return { job, timer, key: job.replaceKey, place: job.place, dueAt, running, follower };
    };
    return [
      ...[...this.scheduled].map(([timer, job]) => of(job, false, timer)),
      ...this.closingJobs.map((job) => of(job, false)),
      ...[...this.running].map((job) => of(job, true)),
    ].filter(({ job }) => job.queueName === queueName && !job.ended) satisfies OrderedJob[];
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
    this.running.add(job);
    const unpacked = unwrapJobPayload(job.payload);
    const active = runCorrelatedJob({
      name: job.name,
      payload: unpacked.payload,
      correlation: unpacked.correlation,
      // Nothing here retries a failed job, so every try is the last one.
      run: () => dispatchJob(handlers, job.name, unpacked.payload, undefined, LAST_ATTEMPT),
    }).catch(() => {
      this.failures.set(job.name, (this.failures.get(job.name) ?? 0) + 1);
    });
    this.active.add(active);
    void active.finally(() => {
      this.active.delete(active);
      this.running.delete(job);
    });
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
