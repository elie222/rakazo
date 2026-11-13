import { getHeapStatistics } from "node:v8";
import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import {
  HISTORY_COMPACT_MAX_ATTEMPTS,
  historyCompactJob,
  messagingReplyJob,
  teamChatAmbientJob,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { DatabaseOutage, databaseCapacityBackoffMs } from "@rakazo/db";
import { createLogger, createTestSink, installLogger, wrapJobPayload } from "@rakazo/logging";
import type * as GraphileWorker from "graphile-worker";
import type { JobHelpers, Runner } from "graphile-worker";
import { makeWorkerUtils } from "graphile-worker";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const run = vi.hoisted(() => vi.fn());

vi.mock("node:v8", () => ({
  getHeapStatistics: vi.fn(() => ({
    used_heap_size: 0,
    external_memory: 0,
    heap_size_limit: 1024 ** 3,
  })),
}));

vi.mock("graphile-worker", async (importOriginal) => ({
  ...(await importOriginal<typeof GraphileWorker>()),
  run: (...args: unknown[]) => run(...args),
  makeWorkerUtils: vi.fn(),
}));

import { RunExecutionHost } from "./run-execution.js";
import {
  createReservedGraphileJobWorkerHost,
  createRoutineRetryNoticeReconciler,
  GraphileJobPublisher,
  GraphileJobWorkerHost,
} from "./wakeup.js";

function handlers(): BackgroundJobHandlers {
  return {
    "run.continue": vi.fn(async () => undefined),
    "routine.wakeup": vi.fn(async () => undefined),
    "routine.retry": vi.fn(async () => undefined),
    "computer.update": vi.fn(async () => undefined),
    "computer.sleep": vi.fn(async () => undefined),
    "computer.control-expire": vi.fn(async () => undefined),
    "skill.teaching-expire": vi.fn(async () => undefined),
    "call.expire": vi.fn(async () => undefined),
    "history.compact": vi.fn(async () => undefined),
    "memory.retain-turn": vi.fn(async () => undefined),
    "memory.purge-history": vi.fn(async () => undefined),
    "messaging.send": vi.fn(async () => undefined),
    "messaging.reply": vi.fn(async () => undefined),
    "messaging.deliver": vi.fn(async () => undefined),
    "messaging.progress": vi.fn(async () => undefined),
    "messaging.credential-cleanup": vi.fn(async () => undefined),
    "team_chat.engage": vi.fn(async () => undefined),
    "team_chat.ambient": vi.fn(async () => undefined),
    "cloud_agent.poll": vi.fn(async () => undefined),
    "purchase.poll": vi.fn(async () => undefined),
    "media.poll": vi.fn(async () => undefined),
    "push.receipt": vi.fn(async () => undefined),
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mockRunner(stop?: () => Promise<void>) {
  const life = deferred();
  // Keep a rejection handler so Node does not treat the mock lifecycle as an
  // unexpected unhandledRejection before the host attaches supervise().
  life.promise.catch(() => undefined);
  const runner = {
    promise: life.promise,
    // As in Graphile, the runner's promise settles once the shutdown stop() waits for is done.
    stop: vi.fn(async () => {
      await stop?.();
      life.resolve();
    }),
    kill: vi.fn(async () => undefined),
    addJob: vi.fn(),
    events: { on: vi.fn(), off: vi.fn(), once: vi.fn(), emit: vi.fn() },
  } as unknown as Runner;
  return {
    runner,
    resolveLife: () => life.resolve(),
    rejectLife: (error: unknown) => life.reject(error),
  };
}

/**
 * A runner whose pool Graphile already began shutting down by itself, as after a breaking
 * migration notice or a fatal job write: stop() skips the pool, which is no longer active,
 * and returns at once, while the runner's promise still waits for that shutdown.
 */
function selfStoppingRunner() {
  const graphile = mockRunner();
  vi.mocked(graphile.runner.stop).mockImplementation(async () => undefined);
  return graphile;
}

/** A runner whose shutdown never completes, as against a database that stopped answering. */
function stalledRunner() {
  return mockRunner(() => new Promise<void>(() => undefined));
}

/**
 * A pool whose single checked-out client answers every query, so a test can
 * land one of Graphile's job-write statements through the host's wrapped pool.
 */
function jobWritePool() {
  const statements: Array<{ name?: string; values?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (config: { name?: string; values?: unknown[] }) => {
      statements.push(config);
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, statements };
}

/** Lands one of Graphile's batched job-write statements on the wrapped pool. */
async function landJobWrite(pool: Pool, name: string, values: unknown[]) {
  const client = await pool.connect();
  try {
    await client.query({ text: name, name, values });
  } finally {
    client.release();
  }
}

/**
 * What Graphile hands a task besides its payload: the job id the host tracks its write by,
 * on a first try of the default 25.
 */
function jobHelpers(id: string) {
  return { job: { id, attempts: 1, max_attempts: 25 } } as unknown as JobHelpers;
}

const tooMany = Object.assign(new Error("sorry, too many clients already"), { code: "53300" });

describe("databaseCapacityBackoffMs", () => {
  it("matches the worker startup backoff curve", () => {
    expect(databaseCapacityBackoffMs(0)).toBe(200);
    expect(databaseCapacityBackoffMs(3)).toBe(1_600);
    expect(databaseCapacityBackoffMs(8)).toBe(30_000);
    expect(databaseCapacityBackoffMs(20)).toBe(30_000);
  });
});

describe("GraphileJobPublisher.enqueue", () => {
  it.each([
    ["user", "run.interactive"],
    ["follow_up", "run.interactive"],
    ["messaging", "run.interactive"],
    ["created", "run.interactive"],
    ["routine", "run.continue"],
    ["bot_message", "run.continue"],
    ["tickets", "run.continue"],
    ["webhook", "run.continue"],
    ["cloud_agent", "run.continue"],
  ])("routes %s from the persisted trigger to %s", async (trigger, task) => {
    const addJob = vi.fn(async () => undefined);
    vi.mocked(makeWorkerUtils).mockResolvedValue({ addJob, release: vi.fn() } as never);
    const findUnique = vi.fn(async () => ({ trigger }));
    const prisma = { run: { findUnique } } as unknown as Pick<PrismaClient, "run">;
    const publisher = new GraphileJobPublisher({} as Pool, prisma);
    try {
      await publisher.enqueue({ name: "run.continue", payload: { runId: "fixture-run" } });
      expect(findUnique).toHaveBeenCalledWith({
        where: { id: "fixture-run" },
        select: { trigger: true },
      });
      expect(addJob).toHaveBeenCalledWith(task, expect.anything(), expect.anything());
    } finally {
      await publisher.close();
    }
  });
  function publisherWith(addJob: ReturnType<typeof vi.fn>) {
    vi.mocked(makeWorkerUtils).mockResolvedValue({
      addJob,
      release: vi.fn(async () => undefined),
    } as never);
    return new GraphileJobPublisher({} as Pool);
  }

  it("forwards the job's maxAttempts cap to graphile", async () => {
    const addJob = vi.fn(async () => undefined);
    const publisher = publisherWith(addJob);
    await publisher.enqueue(historyCompactJob("thread-1"));
    expect(addJob).toHaveBeenCalledWith(
      "history.compact",
      expect.anything(),
      expect.objectContaining({ maxAttempts: HISTORY_COMPACT_MAX_ATTEMPTS }),
    );
    await publisher.close();
  });

  it("leaves the queue default when the job sets no cap", async () => {
    const addJob = vi.fn(async (..._args: unknown[]) => undefined);
    const publisher = publisherWith(addJob);
    await publisher.enqueue(messagingReplyJob("run-1"));
    const options = addJob.mock.calls[0]?.[2] as { maxAttempts?: number } | undefined;
    expect(options?.maxAttempts).toBeUndefined();
    await publisher.close();
  });

  it("forwards the job's queue so one conversation's jobs run one at a time", async () => {
    const addJob = vi.fn(async (..._args: unknown[]) => undefined);
    const publisher = publisherWith(addJob);
    await publisher.enqueue(teamChatAmbientJob("conversation-1", new Date()));
    await publisher.enqueue(historyCompactJob("thread-1"));
    expect(
      addJob.mock.calls.map(([, , spec]) => (spec as { queueName?: string }).queueName),
    ).toEqual(["team_chat.ambient:conversation-1", undefined]);
    await publisher.close();
  });

  type KeyedJob = { attempts: number; maxAttempts: number; runAt: Date; lockedAt?: Date };

  // graphile-worker add_job: unsafe_dedupe on conflict bumps revision only.
  // replace sets attempts = 0 and run_at = excluded.run_at, or detaches a locked
  // job and inserts a new one.
  function graphileJobs(jobs: Map<string, KeyedJob>) {
    const query = vi.fn(async (_sql: string, params?: readonly unknown[]) => {
      const job = jobs.get(String(params?.[0]));
      return {
        rows: job
          ? [
              {
                attempts: job.attempts,
                max_attempts: job.maxAttempts,
                locked_at: job.lockedAt ?? null,
              },
            ]
          : [],
      };
    });
    const addJob = vi.fn(
      async (
        _name: string,
        _payload: unknown,
        spec: { runAt?: Date; jobKey?: string; maxAttempts?: number; jobKeyMode?: string },
      ) => {
        const key = spec.jobKey;
        if (!key) return;
        const existing = jobs.get(key);
        if (spec.jobKeyMode === "unsafe_dedupe" && existing) return;
        jobs.set(key, {
          attempts: 0,
          maxAttempts: spec.maxAttempts ?? 25,
          runAt: spec.runAt ?? new Date(),
        });
      },
    );
    const withPgClient = vi.fn(
      async (callback: (client: { query: typeof query }) => Promise<unknown>) =>
        callback({ query }),
    );
    return { query, addJob, withPgClient };
  }

  function publisherOver(jobs: Map<string, KeyedJob>) {
    const graphile = graphileJobs(jobs);
    vi.mocked(makeWorkerUtils).mockResolvedValue({
      addJob: graphile.addJob,
      withPgClient: graphile.withPgClient,
      release: vi.fn(async () => undefined),
    } as never);
    return { publisher: new GraphileJobPublisher({} as Pool), ...graphile };
  }

  it("keeps attempts and run_at while a keyed job still has attempts left", async () => {
    const runAt = new Date("2030-01-01T00:00:00.000Z");
    const jobs = new Map([["run:run-1", { attempts: 2, maxAttempts: 25, runAt }]]);
    const { publisher, addJob, query } = publisherOver(jobs);
    const pulledForward = new Date("2030-01-01T00:00:01.000Z");
    await publisher.enqueue({
      name: "run.continue",
      payload: { runId: "pulled-forward" },
      replaceKey: "run:run-1",
      availableAt: pulledForward,
      keepExisting: true,
    });
    expect(query).toHaveBeenCalledWith(
      "select attempts, max_attempts, locked_at from graphile_worker._private_jobs where key = $1",
      ["run:run-1"],
    );
    expect(addJob).toHaveBeenCalledWith(
      "run.continue",
      expect.anything(),
      expect.objectContaining({
        jobKey: "run:run-1",
        jobKeyMode: "unsafe_dedupe",
        runAt: pulledForward,
      }),
    );
    expect(jobs.get("run:run-1")).toEqual({ attempts: 2, maxAttempts: 25, runAt });
    await publisher.close();
  });

  it("replaces an exhausted job so it is re-enqueued with fresh attempts", async () => {
    const runAt = new Date("2030-01-01T00:00:00.000Z");
    const jobs = new Map([["run:run-1", { attempts: 3, maxAttempts: 3, runAt }]]);
    const { publisher, addJob } = publisherOver(jobs);
    const revivedAt = new Date("2030-01-02T00:00:00.000Z");
    await publisher.enqueue({
      name: "run.continue",
      payload: { runId: "revived" },
      replaceKey: "run:run-1",
      availableAt: revivedAt,
      keepExisting: true,
    });
    const options = addJob.mock.calls[0]?.[2] as { jobKeyMode?: string } | undefined;
    expect(options?.jobKeyMode).toBeUndefined();
    expect(jobs.get("run:run-1")).toEqual({ attempts: 0, maxAttempts: 25, runAt: revivedAt });
    await publisher.close();
  });

  it("keeps a job locked after replaceLockedBefore", async () => {
    const runAt = new Date("2030-01-01T00:00:00.000Z");
    const lockedAt = new Date("2030-01-01T00:00:01.000Z");
    const jobs = new Map([["run:run-1", { attempts: 1, maxAttempts: 25, runAt, lockedAt }]]);
    const { publisher, addJob } = publisherOver(jobs);
    await publisher.enqueue({
      name: "run.continue",
      payload: { runId: "retry-pending" },
      replaceKey: "run:run-1",
      availableAt: new Date("2030-01-01T00:00:02.000Z"),
      keepExisting: true,
      replaceLockedBefore: new Date("2030-01-01T00:00:00.000Z"),
    });
    const options = addJob.mock.calls[0]?.[2] as { jobKeyMode?: string } | undefined;
    expect(options?.jobKeyMode).toBe("unsafe_dedupe");
    expect(jobs.get("run:run-1")).toEqual({ attempts: 1, maxAttempts: 25, runAt, lockedAt });
    await publisher.close();
  });

  it("replaces a locked job so a worker that died mid-job cannot hold the key", async () => {
    const runAt = new Date("2030-01-01T00:00:00.000Z");
    const lockedAt = new Date("2030-01-01T00:00:01.000Z");
    const jobs = new Map([["run:run-1", { attempts: 1, maxAttempts: 25, runAt, lockedAt }]]);
    const { publisher, addJob } = publisherOver(jobs);
    const reclaimedAt = new Date("2030-01-01T04:00:00.000Z");
    await publisher.enqueue({
      name: "run.continue",
      payload: { runId: "reclaimed" },
      replaceKey: "run:run-1",
      availableAt: reclaimedAt,
      keepExisting: true,
      replaceLockedBefore: lockedAt,
    });
    const options = addJob.mock.calls[0]?.[2] as { jobKeyMode?: string } | undefined;
    expect(options?.jobKeyMode).toBeUndefined();
    expect(jobs.get("run:run-1")).toEqual({ attempts: 0, maxAttempts: 25, runAt: reclaimedAt });
    await publisher.close();
  });

  it("enqueues a keepExisting job when no row has that key", async () => {
    const jobs = new Map<string, KeyedJob>();
    const { publisher, addJob } = publisherOver(jobs);
    const runAt = new Date("2030-01-03T00:00:00.000Z");
    await publisher.enqueue({
      name: "run.continue",
      payload: { runId: "fresh" },
      replaceKey: "run:missing",
      availableAt: runAt,
      keepExisting: true,
    });
    const options = addJob.mock.calls[0]?.[2] as { jobKeyMode?: string } | undefined;
    expect(options?.jobKeyMode).toBeUndefined();
    expect(jobs.get("run:missing")).toEqual({ attempts: 0, maxAttempts: 25, runAt });
    await publisher.close();
  });
});

describe("reserved Graphile workloads", () => {
  afterEach(() => run.mockReset());

  it("reserves disjoint task lists and stops every runner", async () => {
    const runners = [mockRunner(), mockRunner(), mockRunner()];
    for (const { runner } of runners) run.mockResolvedValueOnce(runner);
    const host = createReservedGraphileJobWorkerHost({} as Pool, { concurrency: 4 });
    await host.start(handlers());
    const configurations = run.mock.calls.map(([options]) => options);
    expect(configurations.map(({ concurrency }) => concurrency)).toEqual([4, 1, 100]);
    // The worker's own shutdown hands back runs first; Graphile must not kill the process.
    expect(configurations.map(({ noHandleSignals }) => noHandleSignals)).toEqual([
      true,
      true,
      true,
    ]);
    // Batched job writes are what Graphile's shutdown waits for before the worker
    // exits; prepared statements name them for the wrapped runner pool.
    const batched = { completeJobBatchDelay: 0, failJobBatchDelay: 0, preparedStatements: true };
    expect(configurations.map(({ preset }) => preset)).toEqual([
      { worker: batched },
      { worker: batched },
      { worker: { ...batched, localQueue: { size: 10 } } },
    ]);
    expect(Object.keys(configurations[0].taskList)).toEqual(["run.interactive"]);
    expect(Object.keys(configurations[1].taskList)).toEqual(["run.continue"]);
    expect(Object.keys(configurations[2].taskList)).not.toContain("run.continue");
    expect(Object.keys(configurations[2].taskList)).not.toContain("run.interactive");
    expect(Object.keys(configurations[2].taskList)).toContain("computer.sleep");
    await host.stop();
    for (const { runner } of runners) expect(runner.stop).toHaveBeenCalled();
  });

  it("stops runners already started if another workload cannot start", async () => {
    const first = mockRunner();
    run.mockResolvedValueOnce(first.runner).mockRejectedValueOnce(tooMany);
    const host = createReservedGraphileJobWorkerHost({} as Pool);
    await expect(host.start(handlers())).rejects.toBe(tooMany);
    expect(first.runner.stop).toHaveBeenCalled();
  });

  it("does not start another workload after shutdown interrupts startup", async () => {
    const first = mockRunner();
    let release!: (runner: Runner) => void;
    run.mockReturnValueOnce(
      new Promise<Runner>((resolve) => {
        release = resolve;
      }),
    );
    const host = createReservedGraphileJobWorkerHost({} as Pool);
    const starting = host.start(handlers());
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await host.stop();
    release(first.runner);
    await starting;
    expect(run).toHaveBeenCalledOnce();
    expect(first.runner.stop).toHaveBeenCalledOnce();
  });

  it("dispatches legacy chat jobs after stopping and restarting", async () => {
    for (let i = 0; i < 6; i++) run.mockResolvedValueOnce(mockRunner().runner);
    const host = createReservedGraphileJobWorkerHost({} as Pool);
    const target = handlers();
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        await host.start(target);
        const background = run.mock.calls[cycle * 3 + 1]?.[0].taskList;
        await background["run.continue"](
          wrapJobPayload({ runId: "legacy-chat" }),
          jobHelpers("job-legacy"),
        );
        await host.stop();
      }
      expect(target["run.continue"]).toHaveBeenCalledTimes(2);
      expect(target["run.continue"]).toHaveBeenLastCalledWith(
        { runId: "legacy-chat" },
        { onRunStarted: expect.any(Function) },
        { number: 1, max: 25 },
      );
    } finally {
      await host.stop();
    }
  });
});

describe("GraphileJobWorkerHost runner lifecycle", () => {
  beforeEach(() => {
    vi.mocked(getHeapStatistics).mockReturnValue({
      used_heap_size: 0,
      external_memory: 0,
      heap_size_limit: 1024 ** 3,
    } as ReturnType<typeof getHeapStatistics>);
    vi.spyOn(process, "availableMemory").mockReturnValue(8 * 1024 ** 3);
    // Keep the host's real cgroup file cache out of admission.
    vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
  });
  afterEach(() => {
    run.mockReset();
    vi.mocked(process.availableMemory).mockRestore();
    vi.mocked(process.constrainedMemory).mockRestore();
    vi.useRealTimers();
  });

  it("stops waiting for a handed-off run that outlives the drain deadline", async () => {
    run.mockResolvedValueOnce(mockRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, { concurrency: 1, drainTimeoutMs: 20 });
    const hung = deferred();
    const target = handlers();
    target["run.continue"] = async (_payload, execution) => {
      execution!.onRunStarted();
      await hung.promise;
    };
    try {
      await host.start(target);
      await run.mock.calls[0]![0].taskList["run.continue"](
        { runId: "hung-run" },
        jobHelpers("job-hung"),
      );
      await host.stop();
    } finally {
      hung.resolve();
    }
  });

  it("stops an idle host within the idle bound when the runner's shutdown stalls", async () => {
    run.mockResolvedValueOnce(stalledRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, { idleStopTimeoutMs: 25 });
    await host.start(handlers());
    const stopped = host.stop();
    const outcome = await Promise.race([
      stopped.then(() => "stopped" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
    ]);
    expect(outcome).toBe("stopped");
  });

  it("keeps draining a running job while the runner's shutdown stalls", async () => {
    run.mockResolvedValueOnce(stalledRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: 25,
      // The second assertion below must stay well inside the drain deadline: with
      // a 250 ms deadline it ran at about 200 ms and stop() resolved at about
      // 275 ms, so one late event-loop tick of 75 ms failed the test.
      drainTimeoutMs: 2_000,
    });
    const release = deferred();
    const target = handlers();
    target["run.continue"] = async (_payload, execution) => {
      execution!.onRunStarted();
      await release.promise;
    };
    try {
      await host.start(target);
      await run.mock.calls[0]![0].taskList["run.continue"](
        { runId: "draining-run" },
        jobHelpers("job-draining"),
      );
      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // A job is running, so the idle bound must not cut the drain short.
      expect(stopped).toBe(false);
      release.resolve();
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The run finished, but the runner's shutdown still stalls: only the drain
      // deadline may end the wait, not the idle bound.
      expect(stopped).toBe(false);
      const outcome = await Promise.race([
        stopping.then(() => "stopped" as const),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 5_000)),
      ]);
      expect(outcome).toBe("stopped");
    } finally {
      release.resolve();
      await host.stop();
    }
  });

  it("keeps draining a maintenance job while the runner's shutdown stalls", async () => {
    run.mockResolvedValueOnce(stalledRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: 25,
      // As above: the negative assertions need a wide margin to the deadline.
      drainTimeoutMs: 2_000,
    });
    const release = deferred();
    const target = handlers();
    target["computer.sleep"] = async () => {
      await release.promise;
    };
    try {
      await host.start(target);
      const dispatched = run.mock.calls[0]![0].taskList["computer.sleep"](
        { computerId: "sleeping" },
        jobHelpers("job-sleeping"),
      ).catch(() => undefined);
      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // A maintenance job is not a run execution, but it is still work the idle
      // bound must not cut short.
      expect(stopped).toBe(false);
      release.resolve();
      await dispatched;
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The handler finished, but the runner's shutdown still stalls: only the drain
      // deadline may end the wait, not the idle bound.
      expect(stopped).toBe(false);
      const outcome = await Promise.race([
        stopping.then(() => "stopped" as const),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 5_000)),
      ]);
      expect(outcome).toBe("stopped");
    } finally {
      release.resolve();
      await host.stop();
    }
  });

  it("waits for a finished job's pending completion write within the drain", async () => {
    // Graphile's shutdown completes only once the queued completion write lands.
    const writeLanded = deferred();
    const runner = mockRunner(() => writeLanded.promise.then(() => undefined));
    run.mockResolvedValueOnce(runner.runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: 25,
      drainTimeoutMs: 60_000,
    });
    const release = deferred();
    const target = handlers();
    target["computer.sleep"] = async () => {
      await release.promise;
    };
    try {
      await host.start(target);
      const dispatched = run.mock.calls[0]![0].taskList["computer.sleep"](
        { computerId: "saving" },
        jobHelpers("job-saving"),
      ).catch(() => undefined);
      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stopped).toBe(false);
      release.resolve();
      await dispatched;
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The handler finished, but its completion write has not landed in the database
      // yet; leaving now would keep the job locked until its lock expires.
      expect(stopped).toBe(false);
      writeLanded.resolve();
      const outcome = await Promise.race([
        stopping.then(() => "stopped" as const),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
      ]);
      expect(outcome).toBe("stopped");
    } finally {
      release.resolve();
      writeLanded.resolve();
      await host.stop();
    }
  });

  it("waits for the pending write of a job that finished just before the stop", async () => {
    // The handler settles first; Graphile's shutdown then waits for its queued write.
    const writeLanded = deferred();
    const runner = mockRunner(() => writeLanded.promise.then(() => undefined));
    run.mockResolvedValueOnce(runner.runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: 25,
      drainTimeoutMs: 60_000,
    });
    try {
      await host.start(handlers());
      await run.mock.calls[0]![0].taskList["computer.sleep"](
        { computerId: "saved" },
        jobHelpers("job-just-saved"),
      );
      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Past the idle bound, but the finished job's completion write has not landed yet.
      expect(stopped).toBe(false);
      writeLanded.resolve();
      const outcome = await Promise.race([
        stopping.then(() => "stopped" as const),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
      ]);
      expect(outcome).toBe("stopped");
    } finally {
      writeLanded.resolve();
      await host.stop();
    }
  });

  it("waits for a completion write that predates the stop by over a minute", async () => {
    // Graphile's shutdown never completes while the row-locked write is pending.
    run.mockResolvedValueOnce(stalledRunner().runner);
    const { pool } = jobWritePool();
    const host = new GraphileJobWorkerHost(pool, {
      concurrency: 1,
      idleStopTimeoutMs: 25,
      drainTimeoutMs: 60_000,
    });
    const clock = vi.spyOn(Date, "now");
    try {
      await host.start(handlers());
      const settledAt = new Date("2030-01-01T00:00:00.000Z").getTime();
      clock.mockReturnValue(settledAt);
      await run.mock.calls[0]![0].taskList["computer.sleep"](
        { computerId: "saved" },
        jobHelpers("job-saved"),
      );
      // The stop signal arrives over a minute after the handler settled.
      clock.mockReturnValue(settledAt + 61_000);
      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // However long ago the handler settled, its write is still owed: leaving
      // now would keep the job locked until its lock expires.
      expect(stopped).toBe(false);
      await landJobWrite(run.mock.calls[0]![0].pgPool as Pool, "complete_job/graphile_worker", [
        "job-saved",
      ]);
      const outcome = await Promise.race([
        stopping.then(() => "stopped" as const),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
      ]);
      expect(outcome).toBe("stopped");
    } finally {
      clock.mockRestore();
      await host.stop();
    }
  });

  it("stops within the idle bound once a recent completion fully persisted", async () => {
    // The completion write landed before the stop; only stalled housekeeping —
    // here the runner's unlisten — remains, which the idle bound covers.
    run.mockResolvedValueOnce(stalledRunner().runner);
    const { pool } = jobWritePool();
    const host = new GraphileJobWorkerHost(pool, {
      concurrency: 1,
      idleStopTimeoutMs: 25,
      drainTimeoutMs: 60_000,
    });
    try {
      await host.start(handlers());
      await run.mock.calls[0]![0].taskList["computer.sleep"](
        { computerId: "saved" },
        jobHelpers("job-saved"),
      );
      await landJobWrite(run.mock.calls[0]![0].pgPool as Pool, "complete_job/graphile_worker", [
        "job-saved",
      ]);
      const outcome = await Promise.race([
        host.stop().then(() => "stopped" as const),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
      ]);
      expect(outcome).toBe("stopped");
    } finally {
      await host.stop();
    }
  });

  it("bounds remaining housekeeping by the idle bound once work and writes finish", async () => {
    run.mockResolvedValueOnce(stalledRunner().runner);
    const { pool } = jobWritePool();
    const host = new GraphileJobWorkerHost(pool, {
      concurrency: 1,
      idleStopTimeoutMs: 25,
      drainTimeoutMs: 60_000,
    });
    const release = deferred();
    const target = handlers();
    target["computer.sleep"] = async () => {
      await release.promise;
    };
    try {
      await host.start(target);
      const dispatched = run.mock.calls[0]![0].taskList["computer.sleep"](
        { computerId: "saving" },
        jobHelpers("job-saving"),
      ).catch(() => undefined);
      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Work is running, so the idle bound must not cut the drain short.
      expect(stopped).toBe(false);
      release.resolve();
      await dispatched;
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The handler finished, but its completion write is still owed, so the
      // drain deadline still bounds the wait.
      expect(stopped).toBe(false);
      await landJobWrite(run.mock.calls[0]![0].pgPool as Pool, "complete_job/graphile_worker", [
        "job-saving",
      ]);
      // The write landed and nothing is outstanding: only housekeeping remains,
      // so the idle bound ends the wait though the runner's shutdown stalls.
      const outcome = await Promise.race([
        stopping.then(() => "stopped" as const),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
      ]);
      expect(outcome).toBe("stopped");
    } finally {
      release.resolve();
      await host.stop();
    }
  });

  it("bounds remaining housekeeping once a handed-off run finishes", async () => {
    run.mockResolvedValueOnce(stalledRunner().runner);
    const { pool } = jobWritePool();
    const host = new GraphileJobWorkerHost(pool, {
      concurrency: 1,
      idleStopTimeoutMs: 25,
      drainTimeoutMs: 60_000,
    });
    const release = deferred();
    const target = handlers();
    target["run.continue"] = async (_payload, execution) => {
      execution!.onRunStarted();
      await release.promise;
    };
    try {
      await host.start(target);
      // The wrapper settles at durable handoff; the run keeps executing.
      await run.mock.calls[0]![0].taskList["run.continue"](
        { runId: "handed-off" },
        jobHelpers("job-handed-off"),
      ).catch(() => undefined);
      await landJobWrite(run.mock.calls[0]![0].pgPool as Pool, "complete_job/graphile_worker", [
        "job-handed-off",
      ]);
      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The handed-off run still owns its lease, so the drain bound applies.
      expect(stopped).toBe(false);
      release.resolve();
      // The run finished and its write landed before it: only housekeeping
      // remains, so the idle bound ends the wait though shutdown stalls.
      const outcome = await Promise.race([
        stopping.then(() => "stopped" as const),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
      ]);
      expect(outcome).toBe("stopped");
    } finally {
      release.resolve();
      await host.stop();
    }
  });

  it("waits for a failing job's write until its failure statement lands", async () => {
    // Graphile writes a failure as fail_job/{schema} with [poolId, json] values;
    // the stop may leave only once that statement has landed.
    run.mockResolvedValueOnce(stalledRunner().runner);
    const { pool } = jobWritePool();
    const host = new GraphileJobWorkerHost(pool, {
      concurrency: 1,
      idleStopTimeoutMs: 25,
      drainTimeoutMs: 60_000,
    });
    const target = handlers();
    target["computer.sleep"] = async () => {
      throw new Error("fixture job failure");
    };
    try {
      await host.start(target);
      await run.mock.calls[0]![0].taskList["computer.sleep"](
        { computerId: "failing" },
        jobHelpers("job-failing"),
      ).catch(() => undefined);
      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stopped).toBe(false);
      await landJobWrite(run.mock.calls[0]![0].pgPool as Pool, "fail_job/graphile_worker", [
        "pool-fixture",
        JSON.stringify([{ jobId: "job-failing", message: "fixture" }]),
      ]);
      const outcome = await Promise.race([
        stopping.then(() => "stopped" as const),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
      ]);
      expect(outcome).toBe("stopped");
    } finally {
      await host.stop();
    }
  });

  it("drains a claim racing the stop instead of abandoning it at the idle bound", async () => {
    const writeLanded = deferred();
    const runner = mockRunner(() => writeLanded.promise.then(() => undefined));
    run.mockResolvedValueOnce(runner.runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: 25,
      drainTimeoutMs: 60_000,
    });
    const release = deferred();
    const target = handlers();
    target["computer.sleep"] = async () => {
      await release.promise;
    };
    try {
      await host.start(target);
      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      // Graphile can still deliver a claimed job while the runner's stop deactivates the pool.
      const dispatched = run.mock.calls[0]![0].taskList["computer.sleep"](
        { computerId: "late" },
        jobHelpers("job-late"),
      ).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The claim arrived after the stop signal, so the idle bound must not abandon it.
      expect(stopped).toBe(false);
      release.resolve();
      await dispatched;
      writeLanded.resolve();
      const outcome = await Promise.race([
        stopping.then(() => "stopped" as const),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
      ]);
      expect(outcome).toBe("stopped");
    } finally {
      release.resolve();
      writeLanded.resolve();
      await host.stop();
    }
  });

  it("drains a second claim that races the stop after the first one settled", async () => {
    run.mockResolvedValueOnce(stalledRunner().runner);
    const { pool } = jobWritePool();
    const host = new GraphileJobWorkerHost(pool, {
      concurrency: 2,
      idleStopTimeoutMs: 25,
      drainTimeoutMs: 60_000,
    });
    const release = deferred();
    const target = handlers();
    target["computer.sleep"] = async (payload) => {
      if ((payload as { computerId: string }).computerId === "second") await release.promise;
    };
    try {
      await host.start(target);
      const taskList = run.mock.calls[0]![0].taskList;
      const wrapped = run.mock.calls[0]![0].pgPool as Pool;
      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      // The first late claim settles and persists, so the deadline is back at the idle bound.
      await taskList["computer.sleep"]({ computerId: "first" }, jobHelpers("job-first"));
      await landJobWrite(wrapped, "complete_job/graphile_worker", ["job-first"]);
      // A second claim from another in-flight poll arrives afterwards.
      const second = taskList["computer.sleep"](
        { computerId: "second" },
        jobHelpers("job-second"),
      ).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stopped).toBe(false);
      release.resolve();
      await second;
      await landJobWrite(wrapped, "complete_job/graphile_worker", ["job-second"]);
      const outcome = await Promise.race([
        stopping.then(() => "stopped" as const),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
      ]);
      expect(outcome).toBe("stopped");
    } finally {
      release.resolve();
      await host.stop();
    }
  });

  it("fails a claim delivered after the stop deadline without starting its handler", async () => {
    run.mockResolvedValueOnce(stalledRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, { concurrency: 1, idleStopTimeoutMs: 25 });
    const target = handlers();
    try {
      await host.start(target);
      // Idle, the deadline abandons the stalled runner's shutdown after the idle bound.
      await host.stop();
      // A claim that was still in flight returns afterwards.
      const late = run.mock.calls[0]![0].taskList["computer.sleep"](
        { computerId: "late" },
        jobHelpers("job-late"),
      );
      await expect(late).rejects.toThrow();
      // Graphile fails the job at once, so its handler must not be running here.
      expect(target["computer.sleep"]).not.toHaveBeenCalled();
    } finally {
      await host.stop();
    }
  });

  it("drains a job claimed by a relaunch that the stop interrupts", async () => {
    const first = mockRunner();
    const launched = deferred();
    let relaunched!: Runner;
    run.mockResolvedValueOnce(first.runner).mockImplementationOnce(async () => {
      await launched.promise;
      return relaunched;
    });
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: 25,
      drainTimeoutMs: 60_000,
      sleep: async () => undefined,
    });
    const release = deferred();
    const target = handlers();
    target["computer.sleep"] = async () => {
      await release.promise;
    };
    try {
      await host.start(target);
      first.rejectLife(tooMany);
      // The supervisor relaunches the runner; its run() is still in flight.
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      // The relaunched runner already claimed a job, and its shutdown waits for it.
      let outcome: "pending" | "resolved" | "rejected" = "pending";
      const dispatched = run.mock.calls[1]![0].taskList["computer.sleep"](
        { computerId: "relaunched" },
        jobHelpers("job-relaunched"),
      ).then(
        () => {
          outcome = "resolved";
        },
        () => {
          outcome = "rejected";
        },
      );
      relaunched = mockRunner(() => dispatched).runner;
      launched.resolve();
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Past the idle bound, but the handler is still running: it must not be failed.
      expect(outcome).toBe("pending");
      expect(stopped).toBe(false);
      release.resolve();
      const result = await Promise.race([
        stopping.then(() => "stopped" as const),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
      ]);
      expect(result).toBe("stopped");
      expect(outcome).toBe("resolved");
    } finally {
      release.resolve();
      launched.resolve();
      await host.stop();
    }
  });

  it("drains a running job when Graphile began its own shutdown before the stop", async () => {
    const graphile = selfStoppingRunner();
    run.mockResolvedValueOnce(graphile.runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: 25,
      drainTimeoutMs: 60_000,
    });
    const release = deferred();
    const target = handlers();
    target["computer.sleep"] = async () => {
      await release.promise;
    };
    try {
      await host.start(target);
      let outcome: "pending" | "resolved" | "rejected" = "pending";
      const dispatched = run.mock.calls[0]![0].taskList["computer.sleep"](
        { computerId: "saving" },
        jobHelpers("job-saving"),
      ).then(
        () => {
          outcome = "resolved";
        },
        () => {
          outcome = "rejected";
        },
      );
      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // runner.stop() returned at once, but the handler still runs: leaving now would
      // let the worker close its dependencies under it and leave the job locked.
      expect(outcome).toBe("pending");
      expect(stopped).toBe(false);
      release.resolve();
      await dispatched;
      expect(outcome).toBe("resolved");
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Graphile's shutdown still flushes the job's completion write.
      expect(stopped).toBe(false);
      graphile.resolveLife();
      const result = await Promise.race([
        stopping.then(() => "stopped" as const),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
      ]);
      expect(result).toBe("stopped");
    } finally {
      release.resolve();
      graphile.resolveLife();
      await host.stop();
    }
  });

  it("stops an idle host within the idle bound when Graphile's own shutdown stalls", async () => {
    run.mockResolvedValueOnce(selfStoppingRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, { idleStopTimeoutMs: 25 });
    await host.start(handlers());
    const outcome = await Promise.race([
      host.stop().then(() => "stopped" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
    ]);
    expect(outcome).toBe("stopped");
  });

  it("leaves a restarted host alone when a run abandoned by the previous stop finishes", async () => {
    run.mockResolvedValueOnce(mockRunner().runner).mockResolvedValueOnce(mockRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: 25,
      drainTimeoutMs: 20,
    });
    const hung = deferred();
    const release = deferred();
    const target = handlers();
    target["run.continue"] = async (_payload, execution) => {
      execution!.onRunStarted();
      await hung.promise;
    };
    target["computer.sleep"] = async () => {
      await release.promise;
    };
    try {
      await host.start(target);
      await run.mock.calls[0]![0].taskList["run.continue"](
        { runId: "abandoned-run" },
        jobHelpers("job-abandoned"),
      );
      // The handed-off run outlives the drain deadline, so the stop gives up on it.
      await host.stop();
      await host.start(target);
      // The abandoned run finishes while the restarted host is idle.
      hung.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      let outcome: "pending" | "resolved" | "rejected" = "pending";
      const dispatched = run.mock.calls[1]![0].taskList["computer.sleep"](
        { computerId: "new" },
        jobHelpers("job-new"),
      ).then(
        () => {
          outcome = "resolved";
        },
        () => {
          outcome = "rejected";
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The previous stop is over; nothing of it may fail a job of the new session.
      expect(outcome).toBe("pending");
      release.resolve();
      await dispatched;
      expect(outcome).toBe("resolved");
    } finally {
      hung.resolve();
      release.resolve();
      await host.stop();
    }
  });

  it("releases dispatch slots after durable handoff and drains executions at shutdown", async () => {
    run.mockResolvedValueOnce(mockRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, { concurrency: 4 });
    const release = deferred();
    const target = handlers();
    let started = 0;
    target["run.continue"] = async (_payload, execution) => {
      started++;
      execution!.onRunStarted();
      await release.promise;
    };
    try {
      await host.start(target);
      const dispatch = run.mock.calls[0]![0].taskList["run.continue"];
      await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          dispatch({ runId: `run-${index}` }, jobHelpers(`job-run-${index}`)),
        ),
      );
      expect(started).toBe(5);
      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release.resolve();
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      release.resolve();
      await host.stop();
    }
  });

  it("waits for memory headroom without imposing a resident run count", async () => {
    run.mockResolvedValueOnce(mockRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, { concurrency: 1 });
    const releases = [deferred(), deferred(), deferred()];
    const entered: string[] = [];
    const target = handlers();
    target["run.continue"] = async ({ runId }, execution) => {
      entered.push(runId);
      execution!.onRunStarted();
      await releases[Number(runId)]!.promise;
    };
    try {
      await host.start(target);
      const dispatch = run.mock.calls[0]![0].taskList["run.continue"];
      await dispatch({ runId: "0" }, jobHelpers("job-headroom-0"));
      await dispatch({ runId: "1" }, jobHelpers("job-headroom-1"));
      vi.mocked(process.availableMemory).mockReturnValue(40 * 1024 ** 2);
      const third = dispatch({ runId: "2" }, jobHelpers("job-headroom-2"));
      expect(entered).toEqual(["0", "1"]);
      vi.mocked(process.availableMemory).mockReturnValue(64 * 1024 ** 2);
      releases[0]!.resolve();
      await third;
      expect(entered).toEqual(["0", "1", "2"]);
    } finally {
      for (const release of releases) release.resolve();
      await host.stop();
    }
  });

  it("admits many waiting runs without counting external buffers against V8 heap headroom", async () => {
    const host = new RunExecutionHost();
    const release = deferred();
    let entered = 0;
    const execute = async ({ onRunStarted }: { onRunStarted: () => void }) => {
      entered++;
      onRunStarted();
      await release.promise;
    };
    vi.mocked(process.availableMemory).mockReturnValue(64 * 1024 ** 2);
    vi.mocked(getHeapStatistics).mockReturnValue({
      used_heap_size: 16 * 1024 ** 2,
      external_memory: 2 * 1024 ** 3,
      heap_size_limit: 128 * 1024 ** 2,
    } as ReturnType<typeof getHeapStatistics>);
    try {
      for (let index = 0; index < 100; index++) {
        expect(await host.execute(execute, { waitForCapacity: false })).toBe(true);
      }
      expect(entered).toBe(100);
    } finally {
      release.resolve();
      await host.stop();
    }
  });

  it.each(["physical", "heap", "heap_and_physical"])(
    "logs %s pressure once and measures recovery without logging every poll",
    async (reason) => {
      vi.useFakeTimers();
      const sink = createTestSink();
      installLogger(createLogger({ service: "test", sinks: [sink] }));
      const host = new RunExecutionHost();
      const release = deferred();
      let entered = 0;
      const execute = async ({ onRunStarted }: { onRunStarted: () => void }) => {
        entered++;
        onRunStarted();
        await release.promise;
      };
      try {
        await host.execute(execute);
        vi.mocked(process.availableMemory).mockReturnValue(
          reason.includes("physical") ? 40 * 1024 ** 2 : 8 * 1024 ** 3,
        );
        vi.mocked(getHeapStatistics).mockReturnValue({
          used_heap_size: reason.includes("heap") ? 984 * 1024 ** 2 : 0,
          external_memory: 2 * 1024 ** 3,
          heap_size_limit: 1024 ** 3,
        } as ReturnType<typeof getHeapStatistics>);
        const second = host.execute(execute);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(entered).toBe(1);
        expect(sink.events).toEqual([
          expect.objectContaining({
            message: "run.admission_wait",
            "admission.reason": reason,
            "worker.active_runs": 1,
            "memory.available_bytes": reason.includes("physical") ? 40 * 1024 ** 2 : 8 * 1024 ** 3,
            "memory.heap_available_bytes": reason.includes("heap") ? 40 * 1024 ** 2 : 1024 ** 3,
            "memory.reserve_bytes": 40 * 1024 ** 2,
          }),
        ]);
        vi.mocked(process.availableMemory).mockReturnValue(64 * 1024 ** 2);
        vi.mocked(getHeapStatistics).mockReturnValue({
          used_heap_size: 0,
          external_memory: 2 * 1024 ** 3,
          heap_size_limit: 1024 ** 3,
        } as ReturnType<typeof getHeapStatistics>);
        await vi.advanceTimersByTimeAsync(1_000);
        await second;
        expect(entered).toBe(2);
        expect(sink.events).toHaveLength(2);
        expect(sink.events[1]).toMatchObject({
          message: "run.admission_resumed",
          "admission.reason": reason,
          "run.admission_wait_ms": 3_000,
          "memory.available_bytes": 64 * 1024 ** 2,
        });
      } finally {
        release.resolve();
        await host.stop();
        installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
      }
    },
  );

  it.each(["physical", "heap"])(
    "declines nonwaiting candidates under %s pressure without pinning dispatch or repeating logs",
    async (reason) => {
      vi.useFakeTimers();
      const sink = createTestSink();
      installLogger(createLogger({ service: "test", sinks: [sink] }));
      const host = new RunExecutionHost();
      const release = deferred();
      const resident = async ({ onRunStarted }: { onRunStarted: () => void }) => {
        onRunStarted();
        await release.promise;
      };
      const candidate = vi.fn(resident);
      try {
        expect(await host.execute(resident)).toBe(true);
        vi.mocked(process.availableMemory).mockReturnValue(
          reason === "physical" ? 1 : 8 * 1024 ** 3,
        );
        vi.mocked(getHeapStatistics).mockReturnValue({
          used_heap_size: reason === "heap" ? 984 * 1024 ** 2 : 0,
          external_memory: 0,
          heap_size_limit: 1024 ** 3,
        } as ReturnType<typeof getHeapStatistics>);
        for (let index = 0; index < 8; index++) {
          expect(await host.execute(candidate, { waitForCapacity: false })).toBe(false);
        }
        expect(candidate).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        expect(sink.events).toHaveLength(1);
        expect(sink.events[0]).toMatchObject({
          message: "run.admission_wait",
          "admission.reason": reason,
        });
        await vi.advanceTimersByTimeAsync(5_000);
        vi.mocked(process.availableMemory).mockReturnValue(8 * 1024 ** 3);
        vi.mocked(getHeapStatistics).mockReturnValue({
          used_heap_size: 0,
          external_memory: 0,
          heap_size_limit: 1024 ** 3,
        } as ReturnType<typeof getHeapStatistics>);
        expect(await host.execute(candidate, { waitForCapacity: false })).toBe(true);
        expect(candidate).toHaveBeenCalledOnce();
        expect(sink.events).toHaveLength(2);
        expect(sink.events[1]).toMatchObject({
          message: "run.admission_resumed",
          "run.admission_wait_ms": 5_000,
        });
        vi.mocked(process.availableMemory).mockReturnValue(1);
        expect(await host.execute(candidate, { waitForCapacity: false })).toBe(false);
        expect(sink.events).toHaveLength(3);
        expect(sink.events[2]).toMatchObject({ message: "run.admission_wait" });
      } finally {
        release.resolve();
        await host.stop();
        installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
      }
    },
  );

  it("rejects physical-memory admission waiters and drains resident runs at shutdown", async () => {
    const host = new RunExecutionHost();
    const release = deferred();
    let entered = 0;
    const execute = async ({ onRunStarted }: { onRunStarted: () => void }) => {
      entered++;
      onRunStarted();
      await release.promise;
    };
    try {
      await host.execute(execute);
      vi.mocked(process.availableMemory).mockReturnValue(1);
      const second = host.execute(execute);
      const rejected = expect(second).rejects.toThrow("Worker is stopping");
      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      await rejected;
      expect(entered).toBe(1);
      expect(stopped).toBe(false);
      release.resolve();
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      release.resolve();
      await host.stop();
    }
  });

  it("rejects setup failures through the original queue delivery", async () => {
    run.mockResolvedValueOnce(mockRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool);
    const error = new Error("fixture setup failure");
    const target = handlers();
    target["run.continue"] = async () => {
      throw error;
    };
    try {
      await host.start(target);
      await expect(
        run.mock.calls[0]![0].taskList["run.continue"](
          { runId: "setup-failure" },
          jobHelpers("job-setup-failure"),
        ),
      ).rejects.toBe(error);
    } finally {
      await host.stop();
    }
  });

  it("rechecks memory freed by GC while resident agents remain active", async () => {
    vi.useFakeTimers();
    run.mockResolvedValueOnce(mockRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, { concurrency: 1 });
    const release = deferred();
    let entered = 0;
    const target = handlers();
    target["run.continue"] = async (_payload, execution) => {
      entered++;
      execution!.onRunStarted();
      await release.promise;
    };
    try {
      await host.start(target);
      const dispatch = run.mock.calls[0]![0].taskList["run.continue"];
      await dispatch({ runId: "first" }, jobHelpers("job-gc-first"));
      vi.mocked(process.availableMemory).mockReturnValue(40 * 1024 ** 2);
      const second = dispatch({ runId: "second" }, jobHelpers("job-gc-second"));
      expect(entered).toBe(1);
      vi.mocked(process.availableMemory).mockReturnValue(64 * 1024 ** 2);
      await vi.advanceTimersByTimeAsync(1_000);
      await second;
      expect(entered).toBe(2);
    } finally {
      release.resolve();
      await host.stop();
    }
  });

  it("observes a failure after handoff, reports it once and drains tracking", async () => {
    run.mockResolvedValueOnce(mockRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool);
    const lateFailure = deferred();
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const target = handlers();
    target["run.continue"] = async (_payload, execution) => {
      execution!.onRunStarted();
      await lateFailure.promise;
    };
    try {
      await host.start(target);
      await run.mock.calls[0]![0].taskList["run.continue"](
        { runId: "late-failure" },
        jobHelpers("job-late-failure"),
      );
      lateFailure.reject(new Error("fixture execution failure"));
      await host.stop();
      expect(sink.events.filter((event) => event.level === "error")).toEqual([
        expect.objectContaining({
          message: "job.completed",
          "run.id": "late-failure",
          "job.outcome": "error",
        }),
      ]);
    } finally {
      lateFailure.resolve();
      await host.stop();
      installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
    }
  });

  it.each([
    ["out of connections", tooMany],
    [
      "read-only during a failover",
      Object.assign(new Error("cannot execute UPDATE in a read-only transaction"), {
        code: "25006",
      }),
    ],
    [
      "refusing connections",
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }),
    ],
    ["dropping its connection", new Error("Connection terminated unexpectedly")],
  ])("backs off then restarts when the runner stops with the database %s", async (_, error) => {
    const first = mockRunner();
    const second = mockRunner();
    run.mockResolvedValueOnce(first.runner).mockResolvedValueOnce(second.runner);
    const sleeps: number[] = [];
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      outage: new DatabaseOutage(),
    });

    await host.start(handlers());
    expect(run).toHaveBeenCalledTimes(1);

    first.rejectLife(error);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(sleeps).toEqual([200]);

    await host.stop();
    expect(second.runner.stop).toHaveBeenCalled();
  });

  it("backs off then restarts when job writes stop the runner on a pool checkout timeout", async () => {
    const first = mockRunner();
    const second = mockRunner();
    run.mockResolvedValueOnce(first.runner).mockResolvedValueOnce(second.runner);
    const sleeps: number[] = [];
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await host.start(handlers());
    first.rejectLife(new Error("timeout exceeded when trying to connect"));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(sleeps).toEqual([200]);

    await host.stop();
    expect(second.runner.stop).toHaveBeenCalled();
  });

  it("retries launch with escalating backoff when restart start hits 53300", async () => {
    const first = mockRunner();
    const recovered = mockRunner();
    run
      .mockResolvedValueOnce(first.runner)
      .mockRejectedValueOnce(tooMany)
      .mockResolvedValueOnce(recovered.runner);
    const sleeps: number[] = [];
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await host.start(handlers());
    first.rejectLife(tooMany);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    expect(sleeps).toEqual([200, 400]);

    await host.stop();
    expect(recovered.runner.stop).toHaveBeenCalled();
  });

  it("does not restart when the runner fails for a reason other than the database", async () => {
    const first = mockRunner();
    run.mockResolvedValueOnce(first.runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: async () => undefined,
    });
    await host.start(handlers());
    const superviseTask = (host as unknown as { superviseTask: Promise<void> }).superviseTask;

    first.rejectLife(new Error("runner exploded"));
    await expect(superviseTask).rejects.toThrow("runner exploded");
    expect(run).toHaveBeenCalledTimes(1);

    await host.stop();
  });

  it("logs when history compaction fails permanently", async () => {
    const first = mockRunner();
    run.mockResolvedValueOnce(first.runner);
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: async () => undefined,
    });

    try {
      await host.start(handlers());
      const on = first.runner.events.on as ReturnType<typeof vi.fn>;
      const failed = on.mock.calls.find((call) => call[0] === "job:failed")?.[1] as
        | ((event: {
            job: {
              task_identifier: string;
              payload: unknown;
              attempts: number;
              max_attempts: number;
            };
            error: unknown;
          }) => void)
        | undefined;
      expect(failed).toBeTypeOf("function");
      failed?.({
        job: {
          task_identifier: "history.compact",
          payload: wrapJobPayload({ threadId: "thread-9" }),
          attempts: HISTORY_COMPACT_MAX_ATTEMPTS,
          max_attempts: HISTORY_COMPACT_MAX_ATTEMPTS,
        },
        error: new Error("The operation was aborted due to timeout"),
      });
      failed?.({
        job: {
          task_identifier: "run.continue",
          payload: wrapJobPayload({ runId: "run-1" }),
          attempts: 25,
          max_attempts: 25,
        },
        error: new Error("handler failed"),
      });
    } finally {
      await host.stop();
      installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] }));
    }

    expect(sink.events).toEqual([
      expect.objectContaining({
        level: "error",
        message: "history.compact failed permanently",
        "thread.id": "thread-9",
        "history.compact.reason": "attempts_exhausted",
        "history.compact.retryable": false,
        "job.attempts": HISTORY_COMPACT_MAX_ATTEMPTS,
        "job.max_attempts": HISTORY_COMPACT_MAX_ATTEMPTS,
        error: expect.objectContaining({ message: "The operation was aborted due to timeout" }),
      }),
    ]);
  });

  it("wakes a pending restart delay when stop is called", async () => {
    const first = mockRunner();
    run.mockResolvedValueOnce(first.runner);
    const sleepStarted = deferred();
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: () => {
        sleepStarted.resolve();
        return new Promise(() => undefined);
      },
    });
    await host.start(handlers());
    first.rejectLife(tooMany);
    await sleepStarted.promise;

    await host.stop();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("createRoutineRetryNoticeReconciler", () => {
  function pendingNotices(payloads: unknown[] = [wrapJobPayload({ runId: "run-1" })]) {
    const pending = payloads.map((payload, index) => ({
      id: String(index + 1),
      revision: 2,
      payload,
    }));
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("select")) {
        return {
          rows: pending
            .filter((job) => BigInt(job.id) > BigInt(String(params?.[0])))
            .slice(0, Number(params?.[1])),
        };
      }
      const index = pending.findIndex(
        (job) => job.id === params?.[0] && job.revision === params?.[1],
      );
      if (index >= 0) pending.splice(index, 1);
      return { rows: [] };
    });
    return { pending, query, pool: { query } as unknown as Pool };
  }

  it("retains a failed callback for recovery by a later reconciliation", async () => {
    const { pending, query, pool } = pendingNotices();
    const notify = vi
      .fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue(undefined);
    await createRoutineRetryNoticeReconciler(pool, notify)();
    expect(pending).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);

    // A new pass has no dependence on an event or in-memory retry state.
    await createRoutineRetryNoticeReconciler(pool, notify)();
    expect(notify.mock.calls).toEqual([["run-1"], ["run-1"]]);
    expect(pending).toHaveLength(0);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("revision = $2"), ["1", 2]);
    await createRoutineRetryNoticeReconciler(pool, notify)();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("continues other notices after a failed delivery and skips malformed payloads", async () => {
    const { pool, pending } = pendingNotices([
      { runId: "run-1" },
      wrapJobPayload({ runId: "run-2" }),
      null,
      {},
      { runId: 1 },
      { runId: "" },
    ]);
    const notify = vi
      .fn()
      .mockRejectedValueOnce(new Error("lookup failed"))
      .mockResolvedValue(undefined);
    await createRoutineRetryNoticeReconciler(pool, notify)();
    expect(notify.mock.calls).toEqual([["run-1"], ["run-2"]]);
    expect(pending.map((job) => job.id)).toEqual(["1", "3", "4", "5", "6"]);
  });

  it("retains the request if acknowledging delivery fails", async () => {
    const { pool, query, pending } = pendingNotices();
    query
      .mockImplementationOnce(async () => ({ rows: [...pending] }))
      .mockRejectedValueOnce(new Error("delete failed"));
    const notify = vi.fn(async () => undefined);
    await createRoutineRetryNoticeReconciler(pool, notify)();
    expect(pending).toHaveLength(1);
    await createRoutineRetryNoticeReconciler(pool, notify)();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(pending).toHaveLength(0);
  });

  it("bounds each pass and advances beyond failures before retrying them", async () => {
    const { pool } = pendingNotices(
      Array.from({ length: 21 }, (_, index) => ({ runId: `run-${index + 1}` })),
    );
    const notify = vi.fn(async () => {
      throw new Error("destination unavailable");
    });
    const reconcile = createRoutineRetryNoticeReconciler(pool, notify);
    await reconcile();
    expect(notify).toHaveBeenCalledTimes(20);
    await reconcile();
    expect(notify).toHaveBeenCalledTimes(21);
    expect(notify).toHaveBeenLastCalledWith("run-21");
    await reconcile();
    expect(notify).toHaveBeenCalledTimes(41);
  });

  it("sends concurrently with a bounded number of active deliveries", async () => {
    const { pool } = pendingNotices(
      Array.from({ length: 20 }, (_, index) => ({ runId: `run-${index}` })),
    );
    const release = deferred();
    let active = 0;
    let peak = 0;
    const notify = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await release.promise;
      active -= 1;
    });
    const delivering = createRoutineRetryNoticeReconciler(pool, notify)();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(4));
    release.resolve();
    await delivering;
    expect(notify).toHaveBeenCalledTimes(20);
    expect(peak).toBe(4);
  });

  it("keeps concurrently replaced work when acknowledging a notice", async () => {
    const { pool, pending } = pendingNotices();
    await createRoutineRetryNoticeReconciler(pool, async () => {
      pending[0] = { id: "1", revision: 3, payload: { runId: "new-run" } };
    })();
    expect(pending).toEqual([{ id: "1", revision: 3, payload: { runId: "new-run" } }]);
  });
});
