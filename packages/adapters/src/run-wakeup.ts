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
const INTERACTIVE_QUEUE_WARNING_MS = 30_000;
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
  private wakeRequested = false;
  private readonly cursors: Record<
    "interactive" | "background",
    { createdAt: Date; id: string } | undefined
  > = { interactive: undefined, background: undefined };
  private readonly laneDone = { interactive: false, background: false };
  private nextQueueCheckAt = 0;
  private queueCheck: Promise<void> | undefined;
  private queueDelayed = false;
  private stopping = true;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly realtime: RealtimeFanout,
    private readonly options: { intervalMs?: number; batchSize?: number } = {},
  ) {}

  async start(handlers: BackgroundJobHandlers): Promise<void> {
    if (!this.stopping) return;
    this.stopping = false;
    this.cursors.interactive = undefined;
    this.cursors.background = undefined;
    this.laneDone.interactive = false;
    this.laneDone.background = false;
    this.nextQueueCheckAt = 0;
    this.queueDelayed = false;
    this.wakeRequested = false;
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
    this.checkQueueAge();
    this.scanAgain = true;
    this.wakeRequested = true;
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

  /** Observability must keep running even if a claim or dispatch is slow. */
  private checkQueueAge(): void {
    const now = Date.now();
    if (this.queueCheck || now < this.nextQueueCheckAt) return;
    this.nextQueueCheckAt = now + INTERACTIVE_QUEUE_WARNING_MS;
    this.queueCheck = runAsSystem("interactive queue health", async () => {
      const cutoff = new Date(now - INTERACTIVE_QUEUE_WARNING_MS);
      const [delayed] = await this.prisma.$queryRaw<
        { delayedRuns: number; oldestDueAt: Date | null }[]
      >`
        SELECT COUNT(*)::int AS "delayedRuns",
               MIN(GREATEST("createdAt", COALESCE("wakeAt", "createdAt"))) AS "oldestDueAt"
        FROM runs
        WHERE status = 'queued' AND trigger NOT IN ('routine', 'reaction')
          AND "createdAt" <= ${cutoff}
          AND ("wakeAt" IS NULL OR "wakeAt" <= ${cutoff})
      `;
      if (this.stopping) return;
      if (delayed?.delayedRuns && delayed.oldestDueAt) {
        this.queueDelayed = true;
        getLogger().warn("run.queue_delayed", {
          "queue.delayed_runs": delayed.delayedRuns,
          "queue.oldest_wait_ms": Math.max(0, now - delayed.oldestDueAt.getTime()),
          "queue.warning_after_ms": INTERACTIVE_QUEUE_WARNING_MS,
        });
      } else if (this.queueDelayed) {
        this.queueDelayed = false;
        getLogger().info("run.queue_recovered");
      }
    })
      .catch((error) => {
        if (!this.stopping) getLogger().error("run queue health", error);
      })
      .finally(() => {
        this.queueCheck = undefined;
      });
  }

  private async scan(): Promise<void> {
    // New work can arrive after either lane's query snapshot. External wakes
    // reopen completed lanes without restarting either lane's active pagination.
    if (this.wakeRequested) {
      this.laneDone.interactive = false;
      this.laneDone.background = false;
      this.wakeRequested = false;
    }
    if (!this.laneDone.interactive) await this.scanLane("interactive");
    if (!this.stopping && !this.laneDone.background) await this.scanLane("background");
    if (this.laneDone.interactive && this.laneDone.background) {
      this.laneDone.interactive = false;
      this.laneDone.background = false;
    } else this.scanAgain = true;
  }

  private async scanLane(lane: "interactive" | "background"): Promise<void> {
    const cursor = this.cursors[lane];
    const now = new Date();
    const due: Prisma.RunWhereInput = {
      OR: [{ wakeAt: null }, { wakeAt: { lte: now } }],
    };
    const batchSize = this.options.batchSize ?? 100;
    const rows = await this.prisma.run.findMany({
      where: {
        id: { notIn: [...this.inFlight] },
        trigger:
          lane === "background"
            ? { in: ["routine", "reaction"] }
            : { notIn: ["routine", "reaction"] },
        ...(cursor
          ? {
              AND: [
                {
                  OR: [
                    { createdAt: { gt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { gt: cursor.id } },
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
        const admitted = await this.executions.execute(
          (execution) =>
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
          { waitForCapacity: false },
        );
        if (!admitted) this.inFlight.delete(id);
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
      this.cursors[lane] = rows.at(-1);
    } else {
      this.cursors[lane] = undefined;
      this.laneDone[lane] = true;
    }
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
