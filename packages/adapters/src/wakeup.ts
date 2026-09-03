import {
  type BackgroundJob,
  type BackgroundJobHandlers,
  dispatchBackgroundJob,
  type JobPublisher,
  type JobWorkerHost,
} from "@rakazo/adapter-kit";
import { makeWorkerUtils, type Runner, run, type WorkerUtils } from "graphile-worker";

export class GraphileJobPublisher implements JobPublisher {
  private utils: Promise<WorkerUtils> | undefined;
  private closed = false;

  constructor(private readonly connectionString: string) {}

  async enqueue(job: BackgroundJob): Promise<void> {
    const utils = await this.getUtils();
    await utils.addJob(job.name, job.payload, {
      runAt: job.availableAt,
      jobKey: job.replaceKey,
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
    this.utils ??= makeWorkerUtils({ connectionString: this.connectionString });
    return this.utils;
  }
}

export class GraphileJobWorkerHost implements JobWorkerHost {
  private runner: Runner | undefined;

  constructor(
    private readonly connectionString: string,
    private readonly options: {
      concurrency?: number;
      pollInterval?: number;
      noHandleSignals?: boolean;
    } = {},
  ) {}

  async start(handlers: BackgroundJobHandlers): Promise<void> {
    if (this.runner) return;
    const taskList = Object.fromEntries(
      Object.keys(handlers).map((name) => [
        name,
        async (payload: unknown) => dispatchBackgroundJob(handlers, name, payload),
      ]),
    );
    this.runner = await run({
      connectionString: this.connectionString,
      concurrency: this.options.concurrency ?? 4,
      pollInterval: this.options.pollInterval ?? 500,
      noHandleSignals: this.options.noHandleSignals,
      taskList,
    });
  }

  async stop(): Promise<void> {
    const runner = this.runner;
    this.runner = undefined;
    await runner?.stop();
  }
}

export class InMemoryJobQueue implements JobPublisher, JobWorkerHost {
  private handlers: BackgroundJobHandlers | undefined;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly scheduled = new Map<ReturnType<typeof setTimeout>, BackgroundJob>();
  private readonly keyed = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly active = new Set<Promise<void>>();
  private readonly closingJobs: BackgroundJob[] = [];
  private draining: Promise<void> | undefined;
  private closed = false;
  private stopped = false;
  private closing = false;
  private acceptingClosingJobs = false;
  private closeRequested = false;

  async enqueue(job: BackgroundJob): Promise<void> {
    if (this.closed) throw new Error("Background job publisher is closed");
    if (this.stopped) throw new Error("Background job publisher is stopped");
    if (this.closing) {
      this.enqueueWhileClosing(job);
      return;
    }
    if (job.replaceKey) {
      await this.cancel(job.replaceKey);
      if (this.closed) throw new Error("Background job publisher is closed");
      if (this.stopped) throw new Error("Background job publisher is stopped");
      if (this.closing) {
        this.enqueueWhileClosing(job);
        return;
      }
    }
    const delay = job.availableAt ? Math.max(0, job.availableAt.getTime() - Date.now()) : 0;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.scheduled.delete(timer);
      if (job.replaceKey && this.keyed.get(job.replaceKey) === timer) {
        this.keyed.delete(job.replaceKey);
      }
      const handlers = this.handlers;
      if (!handlers) return;
      void this.dispatch(handlers, job);
    }, delay);
    this.timers.add(timer);
    this.scheduled.set(timer, job);
    if (job.replaceKey) this.keyed.set(job.replaceKey, timer);
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

  async start(handlers: BackgroundJobHandlers): Promise<void> {
    this.handlers = handlers;
    this.stopped = false;
  }

  async stop(): Promise<void> {
    await this.drain();
  }

  private dispatch(handlers: BackgroundJobHandlers, job: BackgroundJob): Promise<void> {
    const active = dispatchBackgroundJob(handlers, job.name, job.payload).catch((error) => {
      console.error(job.name, error);
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

  private enqueueWhileClosing(job: BackgroundJob): void {
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
