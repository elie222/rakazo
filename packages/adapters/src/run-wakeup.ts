import type {
  BackgroundJob,
  BackgroundJobHandlers,
  JobPublisher,
  JobWorkerHost,
  RealtimeFanout,
} from "@rakazo/adapter-kit";
import { dispatchBackgroundJob } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { isTooManyDatabaseConnections, runAsSystem } from "@rakazo/db";
import { getLogger, runCorrelatedJob } from "@rakazo/logging";
import { RunExecutionHost } from "./run-execution.js";

const RUN_READY_TOPIC = "runs:ready";
const RESUMABLE = ["queued", "waiting_input", "waiting_takeover"];

/** Runs are durable in Postgres; notifications only reduce dispatch latency. */
export class RunJobPublisher implements JobPublisher {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly realtime: RealtimeFanout,
    private readonly background: JobPublisher,
  ) {}

  async enqueue(job: BackgroundJob): Promise<void> {
    if (job.name !== "run.continue") return this.background.enqueue(job);
    await this.prisma.run.updateMany({
      where: {
        id: job.payload.runId,
        status: { in: RESUMABLE },
        ...(job.keepExisting ? { wakeAt: null } : {}),
      },
      data: { wakeAt: job.availableAt ?? new Date() },
    });
    // A lost notification is safe: the worker periodically scans runnable rows.
    await this.realtime.publish(RUN_READY_TOPIC, "").catch((error) => {
      getLogger().error("run wakeup notification", error);
    });
  }

  async cancel(key: string): Promise<void> {
    // The durable status is already cancelled. Legacy Graphile deliveries can
    // safely drain as no-ops; chat cancellation needs no scheduler connection.
    if (!key.startsWith("run:")) await this.background.cancel(key);
  }

  async close(): Promise<void> {
    await this.background.close();
  }
}

/** A notification listener plus a recovery scan, with database lease fencing in the executor. */
export class RunWorkerHost implements JobWorkerHost {
  private readonly executions = new RunExecutionHost();
  private readonly inFlight = new Set<string>();
  private handlers: BackgroundJobHandlers | undefined;
  private unsubscribe: (() => Promise<void>) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private scanning: Promise<void> | undefined;
  private scanAgain = false;
  private cursor: { createdAt: Date; id: string } | undefined;
  private stopping = true;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly realtime: RealtimeFanout,
    private readonly options: { intervalMs?: number; batchSize?: number } = {},
  ) {}

  async start(handlers: BackgroundJobHandlers): Promise<void> {
    if (!this.stopping) return;
    this.stopping = false;
    this.handlers = handlers;
    this.executions.start();
    try {
      this.unsubscribe = await this.realtime.subscribe(RUN_READY_TOPIC, () => this.wake());
    } catch (error) {
      this.stopping = true;
      throw error;
    }
    this.timer = setInterval(() => this.wake(), this.options.intervalMs ?? 5_000);
    this.timer.unref?.();
    this.wake();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.unsubscribe?.();
    // Stop admission before awaiting a scan potentially waiting for memory.
    await this.executions.stop();
    await this.scanning;
  }

  private wake(): void {
    if (this.stopping) return;
    this.scanAgain = true;
    if (this.scanning) return;
    this.scanning = runAsSystem("run recovery scan", async () => {
      try {
        while (this.scanAgain && !this.stopping) {
          this.scanAgain = false;
          await this.scan();
        }
      } catch (error) {
        this.scanAgain = false;
        if (!this.stopping) getLogger().error("run dispatch scan", error);
      }
    }).finally(() => {
      this.scanning = undefined;
      if (this.scanAgain && !this.stopping) this.wake();
    });
  }

  private async scan(): Promise<void> {
    const now = new Date();
    const due: Prisma.RunWhereInput = {
      OR: [{ wakeAt: null }, { wakeAt: { lte: now } }],
    };
    const batchSize = this.options.batchSize ?? 100;
    const rows = await this.prisma.run.findMany({
      where: {
        id: { notIn: [...this.inFlight] },
        ...(this.cursor
          ? {
              AND: [
                {
                  OR: [
                    { createdAt: { gt: this.cursor.createdAt } },
                    { createdAt: this.cursor.createdAt, id: { gt: this.cursor.id } },
                  ],
                },
              ],
            }
          : {}),
        OR: [
          { status: "queued", AND: [due] },
          { status: { in: ["leased", "running"] }, leaseExpiresAt: { lte: now } },
          { status: { in: ["waiting_input", "waiting_takeover"] }, wakeAt: { lte: now } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: batchSize,
      select: { id: true, createdAt: true, botId: true, bot: { select: { computerId: true } } },
    });
    // Leave resource waits queued. Reclaiming them on every scan changes their
    // age, hides stuck-work reminders, and produces false execution starts.
    // The executor still acquires the lease atomically to handle races here.
    const leases = rows.length
      ? await this.prisma.computerExecutionLease.findMany({
          where: { botId: { in: rows.map((row) => row.botId) }, expiresAt: { gt: now } },
          select: { computerId: true, botId: true, runId: true },
        })
      : [];
    const runnable = rows.filter(
      (row) =>
        !leases.some(
          (lease) =>
            lease.botId === row.botId &&
            lease.computerId === row.bot.computerId &&
            lease.runId !== row.id,
        ),
    );
    const dispatch = async (id: string) => {
      if (this.stopping) return;
      this.inFlight.add(id);
      try {
        await this.executions.execute((execution) =>
          runCorrelatedJob({
            name: "run.continue",
            payload: { runId: id },
            run: () =>
              runAsSystem("run dispatch", () =>
                dispatchBackgroundJob(
                  this.handlers!,
                  "run.continue",
                  { runId: id },
                  execution,
                ).finally(() => {
                  this.inFlight.delete(id);
                }),
              ),
          }),
        );
      } catch {
        // The durable run remains discoverable. Lease expiry handles failures
        // after a claim; the normal executor handles bounded setup retries.
        this.inFlight.delete(id);
      }
    };
    // Bound simultaneous claims, not agent lifetimes. A slow claim does not
    // hold unrelated chats, while setup cannot flood the database pool.
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, runnable.length) }, async () => {
        while (next < runnable.length && !this.stopping) {
          const row = runnable[next++];
          if (row) await dispatch(row.id);
        }
      }),
    );
    if (rows.length === batchSize) {
      this.cursor = rows.at(-1);
      this.scanAgain = true;
    } else this.cursor = undefined;
  }
}

/** Start direct execution even if the background scheduler is temporarily unavailable. */
export function withRunWorker(runs: RunWorkerHost, background: JobWorkerHost): JobWorkerHost {
  let stopping = false;
  let starting: Promise<void> | undefined;
  return {
    start(handlers) {
      if (stopping) return Promise.resolve();
      if (starting) return starting;
      starting = (async () => {
        try {
          await runs.start(handlers);
          if (!stopping) await background.start(handlers);
        } catch (error) {
          if (!isTooManyDatabaseConnections(error)) {
            await Promise.allSettled([runs.stop(), background.stop()]);
          }
          throw error;
        }
      })().finally(() => {
        starting = undefined;
      });
      return starting;
    },
    async stop() {
      stopping = true;
      // A scheduler start already in flight can create listeners after its first
      // stop. Wait for startup, then stop it again before releasing dependencies.
      const results = await Promise.allSettled([runs.stop(), background.stop(), starting]);
      await background.stop();
      const failed = results.slice(0, 2).find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
  };
}
