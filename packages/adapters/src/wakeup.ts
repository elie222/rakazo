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
    private readonly options: { concurrency?: number; pollInterval?: number } = {},
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
  private readonly keyed = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;

  async enqueue(job: BackgroundJob): Promise<void> {
    if (this.closed) throw new Error("Background job publisher is closed");
    if (job.replaceKey) await this.cancel(job.replaceKey);
    const delay = job.availableAt ? Math.max(0, job.availableAt.getTime() - Date.now()) : 0;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (job.replaceKey && this.keyed.get(job.replaceKey) === timer) {
        this.keyed.delete(job.replaceKey);
      }
      const handlers = this.handlers;
      if (!handlers) return;
      void dispatchBackgroundJob(handlers, job.name, job.payload).catch((error) =>
        console.error(job.name, error),
      );
    }, delay);
    this.timers.add(timer);
    if (job.replaceKey) this.keyed.set(job.replaceKey, timer);
  }

  async cancel(key: string): Promise<void> {
    const timer = this.keyed.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.keyed.delete(key);
    this.timers.delete(timer);
  }

  async start(handlers: BackgroundJobHandlers): Promise<void> {
    this.handlers = handlers;
  }

  async stop(): Promise<void> {
    this.handlers = undefined;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.keyed.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stop();
  }
}
