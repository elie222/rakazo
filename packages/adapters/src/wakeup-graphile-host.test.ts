import { getHeapStatistics } from "node:v8";
import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import {
  HISTORY_COMPACT_MAX_ATTEMPTS,
  historyCompactJob,
  messagingReplyJob,
  RetryJobLaterError,
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

/** When the fixture claims were locked, as Graphile returns it: cut to the millisecond. */
const LOCKED_AT = new Date("2026-01-01T00:00:00.123Z");

/**
 * What Graphile hands a task besides its payload: the job id the host tracks its write by,
 * locked by the runner's pool at LOCKED_AT, by default on a first try of the default 25.
 */
function jobHelpers(
  id: string,
  options: {
    attempts?: number;
    max_attempts?: number;
    withPgClient?: JobHelpers["withPgClient"];
  } = {},
) {
  const { attempts = 1, max_attempts = 25, withPgClient } = options;
  return {
    job: { id, attempts, max_attempts, locked_by: "pool-fixture", locked_at: LOCKED_AT },
    withPgClient,
  } as unknown as JobHelpers;
}

/**
 * A task's database checkout, which hands out its client once `ready` settles; each
 * statement reports `rowCount` matched rows.
 */
function checkoutFixture(ready: Promise<void> = Promise.resolve(), rowCount = 1) {
  const client = {
    query: vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [], rowCount })),
  };
  const withPgClient = (async (callback: (pgClient: typeof client) => Promise<unknown>) => {
    await ready;
    return callback(client);
  }) as unknown as JobHelpers["withPgClient"];
  return { client, withPgClient };
}

/** Reports whether a promise has settled, for tests that step fake timers. */
function settles(promise: Promise<unknown>) {
  const state = { settled: false };
  void promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

/** The stop bounds the lifecycle tests run with, on fake timers. */
const IDLE_MS = 25;
const DRAIN_MS = 60_000;
/**
 * Once a deadline gives up on a stop during which work ran, the writes of that work get the
 * idle bound once more to land.
 */
const WRITE_ALLOWANCE_MS = IDLE_MS;

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
    vi.useFakeTimers();
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
      const stopped = settles(host.stop());
      await vi.advanceTimersByTimeAsync(19);
      expect(stopped.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(stopped.settled).toBe(true);
    } finally {
      hung.resolve();
    }
  });

  it("stops an idle host within the idle bound when the runner's shutdown stalls", async () => {
    vi.useFakeTimers();
    run.mockResolvedValueOnce(stalledRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, { idleStopTimeoutMs: IDLE_MS });
    await host.start(handlers());
    const stopped = settles(host.stop());
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(stopped.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped.settled).toBe(true);
  });

  it("keeps draining a running job while the runner's shutdown stalls", async () => {
    vi.useFakeTimers();
    run.mockResolvedValueOnce(stalledRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: IDLE_MS,
      drainTimeoutMs: DRAIN_MS,
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
      const stopped = settles(host.stop());
      await vi.advanceTimersByTimeAsync(1_000);
      // A job is running, so the idle bound must not cut the drain short.
      expect(stopped.settled).toBe(false);
      release.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      // The run finished, but the runner's shutdown still stalls: only the drain
      // deadline may end the wait, not the idle bound.
      expect(stopped.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(DRAIN_MS - 2_000);
      // At the deadline the owed writes get the idle bound to land.
      expect(stopped.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(IDLE_MS);
      expect(stopped.settled).toBe(true);
    } finally {
      release.resolve();
      await host.stop();
    }
  });

  it("keeps draining a maintenance job while the runner's shutdown stalls", async () => {
    vi.useFakeTimers();
    run.mockResolvedValueOnce(stalledRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: IDLE_MS,
      drainTimeoutMs: DRAIN_MS,
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
      const stopped = settles(host.stop());
      await vi.advanceTimersByTimeAsync(1_000);
      // A maintenance job is not a run execution, but it is still work the idle
      // bound must not cut short.
      expect(stopped.settled).toBe(false);
      release.resolve();
      await dispatched;
      await vi.advanceTimersByTimeAsync(1_000);
      // The handler finished, but the runner's shutdown still stalls: only the drain
      // deadline may end the wait, not the idle bound.
      expect(stopped.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(DRAIN_MS - 2_000 + IDLE_MS);
      expect(stopped.settled).toBe(true);
    } finally {
      release.resolve();
      await host.stop();
    }
  });

  it("waits for a finished job's pending completion write within the drain", async () => {
    vi.useFakeTimers();
    // Graphile's shutdown completes only once the queued completion write lands.
    const writeLanded = deferred();
    const runner = mockRunner(() => writeLanded.promise.then(() => undefined));
    run.mockResolvedValueOnce(runner.runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: IDLE_MS,
      drainTimeoutMs: DRAIN_MS,
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
      const stopped = settles(host.stop());
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stopped.settled).toBe(false);
      release.resolve();
      await dispatched;
      await vi.advanceTimersByTimeAsync(1_000);
      // The handler finished, but its completion write has not landed in the database
      // yet; leaving now would keep the job locked until its lock expires.
      expect(stopped.settled).toBe(false);
      writeLanded.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped.settled).toBe(true);
    } finally {
      release.resolve();
      writeLanded.resolve();
      await host.stop();
    }
  });

  it("waits for the pending write of a job that finished just before the stop", async () => {
    vi.useFakeTimers();
    // The handler settles first; Graphile's shutdown then waits for its queued write.
    const writeLanded = deferred();
    const runner = mockRunner(() => writeLanded.promise.then(() => undefined));
    run.mockResolvedValueOnce(runner.runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: IDLE_MS,
      drainTimeoutMs: DRAIN_MS,
    });
    try {
      await host.start(handlers());
      await run.mock.calls[0]![0].taskList["computer.sleep"](
        { computerId: "saved" },
        jobHelpers("job-just-saved"),
      );
      const stopped = settles(host.stop());
      await vi.advanceTimersByTimeAsync(1_000);
      // Past the idle bound, but the finished job's completion write has not landed yet.
      expect(stopped.settled).toBe(false);
      writeLanded.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped.settled).toBe(true);
    } finally {
      writeLanded.resolve();
      await host.stop();
    }
  });

  it("waits for a completion write that predates the stop by over a minute", async () => {
    vi.useFakeTimers();
    // Graphile's shutdown never completes while the row-locked write is pending.
    run.mockResolvedValueOnce(stalledRunner().runner);
    const { pool } = jobWritePool();
    const host = new GraphileJobWorkerHost(pool, {
      concurrency: 1,
      idleStopTimeoutMs: IDLE_MS,
      drainTimeoutMs: DRAIN_MS,
    });
    try {
      await host.start(handlers());
      await run.mock.calls[0]![0].taskList["computer.sleep"](
        { computerId: "saved" },
        jobHelpers("job-saved"),
      );
      // The stop signal arrives over a minute after the handler settled.
      await vi.advanceTimersByTimeAsync(61_000);
      const stopped = settles(host.stop());
      await vi.advanceTimersByTimeAsync(1_000);
      // However long ago the handler settled, its write is still owed: leaving
      // now would keep the job locked until its lock expires.
      expect(stopped.settled).toBe(false);
      await landJobWrite(run.mock.calls[0]![0].pgPool as Pool, "complete_job/graphile_worker", [
        "job-saved",
      ]);
      await vi.advanceTimersByTimeAsync(IDLE_MS + WRITE_ALLOWANCE_MS);
      expect(stopped.settled).toBe(true);
    } finally {
      await host.stop();
    }
  });

  it("stops within the idle bound once a recent completion fully persisted", async () => {
    vi.useFakeTimers();
    // The completion write landed before the stop; only stalled housekeeping —
    // here the runner's unlisten — remains, which the idle bound covers.
    run.mockResolvedValueOnce(stalledRunner().runner);
    const { pool } = jobWritePool();
    const host = new GraphileJobWorkerHost(pool, {
      concurrency: 1,
      idleStopTimeoutMs: IDLE_MS,
      drainTimeoutMs: DRAIN_MS,
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
      const stopped = settles(host.stop());
      await vi.advanceTimersByTimeAsync(IDLE_MS);
      expect(stopped.settled).toBe(true);
    } finally {
      await host.stop();
    }
  });

  it("bounds remaining housekeeping by the idle bound once work and writes finish", async () => {
    vi.useFakeTimers();
    run.mockResolvedValueOnce(stalledRunner().runner);
    const { pool } = jobWritePool();
    const host = new GraphileJobWorkerHost(pool, {
      concurrency: 1,
      idleStopTimeoutMs: IDLE_MS,
      drainTimeoutMs: DRAIN_MS,
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
      const stopped = settles(host.stop());
      await vi.advanceTimersByTimeAsync(1_000);
      // Work is running, so the idle bound must not cut the drain short.
      expect(stopped.settled).toBe(false);
      release.resolve();
      await dispatched;
      await vi.advanceTimersByTimeAsync(1_000);
      // The handler finished, but its completion write is still owed, so the
      // drain deadline still bounds the wait.
      expect(stopped.settled).toBe(false);
      await landJobWrite(run.mock.calls[0]![0].pgPool as Pool, "complete_job/graphile_worker", [
        "job-saving",
      ]);
      // The write landed and nothing is outstanding: only housekeeping remains,
      // so the idle bound ends the wait though the runner's shutdown stalls.
      await vi.advanceTimersByTimeAsync(IDLE_MS + WRITE_ALLOWANCE_MS);
      expect(stopped.settled).toBe(true);
    } finally {
      release.resolve();
      await host.stop();
    }
  });

  it("bounds remaining housekeeping once a handed-off run finishes", async () => {
    vi.useFakeTimers();
    run.mockResolvedValueOnce(stalledRunner().runner);
    const { pool } = jobWritePool();
    const host = new GraphileJobWorkerHost(pool, {
      concurrency: 1,
      idleStopTimeoutMs: IDLE_MS,
      drainTimeoutMs: DRAIN_MS,
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
      const stopped = settles(host.stop());
      await vi.advanceTimersByTimeAsync(1_000);
      // The handed-off run still owns its lease, so the drain bound applies.
      expect(stopped.settled).toBe(false);
      release.resolve();
      // The run finished and its write landed before it: only housekeeping
      // remains, so the idle bound ends the wait though shutdown stalls.
      await vi.advanceTimersByTimeAsync(IDLE_MS + WRITE_ALLOWANCE_MS);
      expect(stopped.settled).toBe(true);
    } finally {
      release.resolve();
      await host.stop();
    }
  });

  it("waits for a failing job's write until its failure statement lands", async () => {
    vi.useFakeTimers();
    // Graphile writes a failure as fail_job/{schema} with [poolId, json] values;
    // the stop may leave only once that statement has landed.
    run.mockResolvedValueOnce(stalledRunner().runner);
    const { pool } = jobWritePool();
    const host = new GraphileJobWorkerHost(pool, {
      concurrency: 1,
      idleStopTimeoutMs: IDLE_MS,
      drainTimeoutMs: DRAIN_MS,
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
      const stopped = settles(host.stop());
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stopped.settled).toBe(false);
      await landJobWrite(run.mock.calls[0]![0].pgPool as Pool, "fail_job/graphile_worker", [
        "pool-fixture",
        JSON.stringify([{ jobId: "job-failing", message: "fixture" }]),
      ]);
      await vi.advanceTimersByTimeAsync(IDLE_MS + WRITE_ALLOWANCE_MS);
      expect(stopped.settled).toBe(true);
    } finally {
      await host.stop();
    }
  });

  it("drains a claim racing the stop instead of abandoning it at the idle bound", async () => {
    vi.useFakeTimers();
    const writeLanded = deferred();
    const runner = mockRunner(() => writeLanded.promise.then(() => undefined));
    run.mockResolvedValueOnce(runner.runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: IDLE_MS,
      drainTimeoutMs: DRAIN_MS,
    });
    const release = deferred();
    const target = handlers();
    target["computer.sleep"] = async () => {
      await release.promise;
    };
    try {
      await host.start(target);
      const stopped = settles(host.stop());
      // Graphile can still deliver a claimed job while the runner's stop deactivates the pool.
      const dispatched = run.mock.calls[0]![0].taskList["computer.sleep"](
        { computerId: "late" },
        jobHelpers("job-late"),
      ).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(1_000);
      // The claim arrived after the stop signal, so the idle bound must not abandon it.
      expect(stopped.settled).toBe(false);
      release.resolve();
      await dispatched;
      writeLanded.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped.settled).toBe(true);
    } finally {
      release.resolve();
      writeLanded.resolve();
      await host.stop();
    }
  });

  it("drains a second claim that races the stop after the first one settled", async () => {
    vi.useFakeTimers();
    run.mockResolvedValueOnce(stalledRunner().runner);
    const { pool } = jobWritePool();
    const host = new GraphileJobWorkerHost(pool, {
      concurrency: 2,
      idleStopTimeoutMs: IDLE_MS,
      drainTimeoutMs: DRAIN_MS,
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
      const stopped = settles(host.stop());
      // The first late claim settles and persists, so the deadline is back at the idle bound.
      await taskList["computer.sleep"]({ computerId: "first" }, jobHelpers("job-first"));
      await landJobWrite(wrapped, "complete_job/graphile_worker", ["job-first"]);
      // A second claim from another in-flight poll arrives afterwards.
      const second = taskList["computer.sleep"](
        { computerId: "second" },
        jobHelpers("job-second"),
      ).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stopped.settled).toBe(false);
      release.resolve();
      await second;
      await landJobWrite(wrapped, "complete_job/graphile_worker", ["job-second"]);
      await vi.advanceTimersByTimeAsync(IDLE_MS + WRITE_ALLOWANCE_MS);
      expect(stopped.settled).toBe(true);
    } finally {
      release.resolve();
      await host.stop();
    }
  });

  it("fails a claim delivered after the stop deadline without starting its handler", async () => {
    vi.useFakeTimers();
    run.mockResolvedValueOnce(stalledRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: IDLE_MS,
    });
    const target = handlers();
    try {
      await host.start(target);
      // Idle, the deadline abandons the stalled runner's shutdown after the idle bound.
      const stopped = host.stop();
      await vi.advanceTimersByTimeAsync(IDLE_MS);
      await stopped;
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

  it("gives back the attempt of a last-try claim refused after the stop gave up", async () => {
    vi.useFakeTimers();
    const graphile = stalledRunner();
    run.mockResolvedValueOnce(graphile.runner);
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: IDLE_MS,
    });
    const target = handlers();
    const { client, withPgClient } = checkoutFixture();
    try {
      await host.start(target);
      const stopped = host.stop();
      await vi.advanceTimersByTimeAsync(IDLE_MS);
      await stopped;
      // The late claim already counted the job's last attempt.
      const late = run.mock.calls[0]![0].taskList["history.compact"](
        wrapJobPayload({ threadId: "thread-late" }),
        jobHelpers("job-last", {
          attempts: HISTORY_COMPACT_MAX_ATTEMPTS,
          max_attempts: HISTORY_COMPACT_MAX_ATTEMPTS,
          withPgClient,
        }),
      );
      const error = await late.then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      expect(target["history.compact"]).not.toHaveBeenCalled();
      // The claim's attempt goes back, but the job stays locked: the pool's lock does not
      // tell its claims apart, so only Graphile's own failure write that follows may
      // release it, or that write could hit a newer claim of the same job by this pool.
      expect(client.query).toHaveBeenCalledTimes(1);
      const [text, values] = client.query.mock.calls[0]!;
      expect(text).toContain("attempts = greatest(0, attempts - 1)");
      expect(text).not.toContain("locked_by = null");
      // The attempt count changes with every claim and give-back, so the claim is matched by
      // when it was locked: Graphile hands that time over cut to the millisecond.
      expect(text).toContain(
        "locked_by = $2::text and date_trunc('milliseconds', locked_at) = $3::timestamptz",
      );
      expect(text).not.toContain("attempts = $");
      expect(values).toEqual(["job-last", "pool-fixture", LOCKED_AT]);
      // Graphile reports the refusal as the job failing for good on its last attempt;
      // the attempt was given back, so nothing may record the job as exhausted.
      const on = graphile.runner.events.on as ReturnType<typeof vi.fn>;
      const failed = on.mock.calls.find((call) => call[0] === "job:failed")?.[1] as (event: {
        job: object;
        error: unknown;
      }) => void;
      failed({
        job: {
          task_identifier: "history.compact",
          payload: wrapJobPayload({ threadId: "thread-late" }),
          attempts: HISTORY_COMPACT_MAX_ATTEMPTS,
          max_attempts: HISTORY_COMPACT_MAX_ATTEMPTS,
        },
        error,
      });
      expect(sink.events.filter((event) => event.message.startsWith("history.compact"))).toEqual(
        [],
      );
    } finally {
      await host.stop();
      installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] }));
    }
  });

  it("records a refused last try as exhausted when its attempt could not be given back", async () => {
    vi.useFakeTimers();
    const graphile = stalledRunner();
    run.mockResolvedValueOnce(graphile.runner);
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: IDLE_MS,
    });
    const target = handlers();
    // The give-back finds no row this claim still holds, so the attempt stays used up.
    const { withPgClient } = checkoutFixture(Promise.resolve(), 0);
    try {
      await host.start(target);
      const stopped = host.stop();
      await vi.advanceTimersByTimeAsync(IDLE_MS);
      await stopped;
      const job = {
        task_identifier: "history.compact",
        payload: wrapJobPayload({ threadId: "thread-late" }),
        attempts: HISTORY_COMPACT_MAX_ATTEMPTS,
        max_attempts: HISTORY_COMPACT_MAX_ATTEMPTS,
      };
      const error = await run.mock.calls[0]![0].taskList["history.compact"](
        job.payload,
        jobHelpers("job-last", {
          attempts: job.attempts,
          max_attempts: job.max_attempts,
          withPgClient,
        }),
      ).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      const on = graphile.runner.events.on as ReturnType<typeof vi.fn>;
      const failed = on.mock.calls.find((call) => call[0] === "job:failed")?.[1] as (event: {
        job: object;
        error: unknown;
      }) => void;
      failed({ job, error });
      expect(
        sink.events.filter((event) => event.message.startsWith("history.compact")),
      ).toHaveLength(1);
    } finally {
      await host.stop();
      installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] }));
    }
  });

  it("keeps an earlier claim's late write response from clearing a newer claim's write", async () => {
    vi.useFakeTimers();
    run.mockResolvedValueOnce(stalledRunner().runner);
    // The database answers each statement only when the test lets it.
    const answers: Array<() => void> = [];
    const client = {
      query: vi.fn(
        () =>
          new Promise<{ rows: [] }>((resolve) => {
            answers.push(() => resolve({ rows: [] }));
          }),
      ),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const host = new GraphileJobWorkerHost(pool, {
      concurrency: 2,
      idleStopTimeoutMs: IDLE_MS,
      drainTimeoutMs: DRAIN_MS,
    });
    const target = handlers();
    target["computer.sleep"] = async () => {
      throw new Error("fixture job failure");
    };
    const failWrite = () => ({
      text: "fail_job",
      name: "fail_job/graphile_worker",
      values: ["pool-fixture", JSON.stringify([{ jobId: "job-again", message: "fixture" }])],
    });
    try {
      await host.start(target);
      const taskList = run.mock.calls[0]![0].taskList;
      const wrapped = run.mock.calls[0]![0].pgPool as Pool;
      const stopped = settles(host.stop());
      // A claim racing the stop fails; its failure write commits, which unlocks the job,
      // but the response is still on its way back.
      await taskList["computer.sleep"]({ computerId: "again" }, jobHelpers("job-again")).catch(
        () => undefined,
      );
      const earlier = (await wrapped.connect()).query(failWrite());
      // Another claim of the same job, by this pool, fails as well; its write is owed.
      await taskList["computer.sleep"](
        { computerId: "again" },
        jobHelpers("job-again", { attempts: 2 }),
      ).catch(() => undefined);
      answers[0]!();
      await earlier;
      await vi.advanceTimersByTimeAsync(1_000);
      // The response belonged to the earlier claim; the newer claim's write is still owed.
      expect(stopped.settled).toBe(false);
      const newer = (await wrapped.connect()).query(failWrite());
      answers[1]!();
      await newer;
      await vi.advanceTimersByTimeAsync(IDLE_MS + WRITE_ALLOWANCE_MS);
      expect(stopped.settled).toBe(true);
    } finally {
      for (const answer of answers) answer();
      const last = host.stop();
      await vi.advanceTimersByTimeAsync(DRAIN_MS + IDLE_MS);
      await last;
    }
  });

  /**
   * A host on a stalled runner with a local queue, whose wrapped pool answers or fails each
   * statement only when the test lets it, and a way to report jobs the local queue returns.
   */
  async function returningHost() {
    const graphile = stalledRunner();
    run.mockResolvedValueOnce(graphile.runner);
    const answers: Array<{ resolve: () => void; reject: () => void }> = [];
    const client = {
      query: vi.fn(
        () =>
          new Promise<{ rows: [] }>((resolve, reject) => {
            answers.push({
              resolve: () => resolve({ rows: [] }),
              reject: () => reject(new Error("fixture lost response")),
            });
          }),
      ),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const host = new GraphileJobWorkerHost(pool, {
      concurrency: 1,
      idleStopTimeoutMs: IDLE_MS,
      drainTimeoutMs: DRAIN_MS,
      localQueueSize: 10,
    });
    await host.start(handlers());
    const on = graphile.runner.events.on as ReturnType<typeof vi.fn>;
    const returned = on.mock.calls.find(
      (call) => call[0] === "localQueue:returnJobs",
    )![1] as (event: { jobs: Array<{ id: string }> }) => void;
    const wrapped = run.mock.calls[0]![0].pgPool as Pool;
    // Sends Graphile's return write for one job; its retries send the same statement again.
    const sendReturn = async (id: string) => {
      const sent = (await wrapped.connect()).query({
        text: "return_job",
        name: "return_job/graphile_worker",
        values: ["pool-fixture", [id]],
      });
      sent.catch(() => undefined);
      return { sent };
    };
    return { host, answers, returned, sendReturn };
  }

  it("keeps a newer claim's write owed when a retry of an earlier write lands", async () => {
    vi.useFakeTimers();
    const { host, answers, returned, sendReturn } = await returningHost();
    try {
      returned({ jobs: [{ id: "job-again" }] });
      // The earlier return commits, which unlocks the job, but its response fails.
      const earlier = await sendReturn("job-again");
      answers[0]!.reject();
      await earlier.sent.catch(() => undefined);
      // The job is claimed and returned again before Graphile retries the earlier write.
      returned({ jobs: [{ id: "job-again" }] });
      const stopped = settles(host.stop());
      // The retry lands; it settles the earlier claim, not the newer one.
      const retry = await sendReturn("job-again");
      answers[1]!.resolve();
      await retry.sent;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stopped.settled).toBe(false);
    } finally {
      for (const answer of answers) answer.resolve();
      const last = host.stop();
      await vi.advanceTimersByTimeAsync(DRAIN_MS + IDLE_MS);
      await last;
    }
  });

  it("clears a write once its retry lands after a failed response", async () => {
    vi.useFakeTimers();
    const { host, answers, returned, sendReturn } = await returningHost();
    try {
      returned({ jobs: [{ id: "job-once" }] });
      const first = await sendReturn("job-once");
      answers[0]!.reject();
      await first.sent.catch(() => undefined);
      const stopped = settles(host.stop());
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stopped.settled).toBe(false);
      // No newer claim exists, so the retry landing settles the only write owed.
      const retry = await sendReturn("job-once");
      answers[1]!.resolve();
      await retry.sent;
      await vi.advanceTimersByTimeAsync(IDLE_MS + WRITE_ALLOWANCE_MS);
      expect(stopped.settled).toBe(true);
    } finally {
      for (const answer of answers) answer.resolve();
      const last = host.stop();
      await vi.advanceTimersByTimeAsync(DRAIN_MS + IDLE_MS);
      await last;
    }
  });

  it("limits a retry update to the claim that asked for it", async () => {
    vi.useFakeTimers();
    run.mockResolvedValueOnce(stalledRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: IDLE_MS,
      drainTimeoutMs: 1_000,
    });
    const target = handlers();
    target["computer.sleep"] = async () => {
      throw new RetryJobLaterError(5_000);
    };
    // The run_at update is sent, but the database has not answered it yet.
    const answer = deferred();
    const { client, withPgClient } = checkoutFixture();
    client.query.mockImplementation(async () => {
      await answer.promise;
      return { rows: [], rowCount: 1 };
    });
    try {
      await host.start(target);
      const dispatched = settles(
        run.mock.calls[0]![0].taskList["computer.sleep"](
          { computerId: "retry" },
          jobHelpers("job-retry", { attempts: 3, withPgClient }),
        ),
      );
      const stopped = settles(host.stop());
      await vi.advanceTimersByTimeAsync(0);
      expect(client.query).toHaveBeenCalledTimes(1);
      // The drain deadline abandons the job while its update is in flight. Graphile's
      // failure write then unlocks it, and another claim may hold it by the time the
      // update executes, so the update must match only this claim's lock.
      await vi.advanceTimersByTimeAsync(1_000 + IDLE_MS);
      expect(stopped.settled).toBe(true);
      expect(dispatched.settled).toBe(true);
      const [text, values] = client.query.mock.calls[0]!;
      expect(text.replace(/\s+/g, " ")).toContain(
        "where id = $1::bigint and locked_by = $3::text" +
          " and date_trunc('milliseconds', locked_at) = $4::timestamptz",
      );
      expect(values).toEqual(["job-retry", 5_000, "pool-fixture", LOCKED_AT]);
    } finally {
      answer.resolve();
      const last = host.stop();
      await vi.advanceTimersByTimeAsync(1_000 + IDLE_MS);
      await last;
    }
  });

  it("keeps a retry update whose checkout stalls past the stop from writing later", async () => {
    vi.useFakeTimers();
    run.mockResolvedValueOnce(stalledRunner().runner).mockResolvedValueOnce(stalledRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: IDLE_MS,
      drainTimeoutMs: 1_000,
    });
    const target = handlers();
    target["computer.sleep"] = async () => {
      throw new RetryJobLaterError(5_000);
    };
    const checkout = deferred();
    const { client, withPgClient } = checkoutFixture(checkout.promise);
    try {
      await host.start(target);
      const dispatched = settles(
        run.mock.calls[0]![0].taskList["computer.sleep"](
          { computerId: "retry" },
          jobHelpers("job-retry", { withPgClient }),
        ),
      );
      const stopped = settles(host.stop());
      // The handler asked to retry later, and the checkout for its run_at update stalls,
      // so the drain deadline gives up on it.
      await vi.advanceTimersByTimeAsync(1_000 + IDLE_MS);
      expect(stopped.settled).toBe(true);
      // The job's lifetime ended with the stop; it must not linger on the checkout.
      expect(dispatched.settled).toBe(true);
      await host.start(target);
      // The checkout comes back after the stop returned and the host restarted.
      checkout.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.query).not.toHaveBeenCalled();
      // Nothing of the abandoned job may hold the restarted session's stop.
      const restarted = settles(host.stop());
      await vi.advanceTimersByTimeAsync(IDLE_MS);
      expect(restarted.settled).toBe(true);
    } finally {
      checkout.resolve();
      const last = host.stop();
      await vi.advanceTimersByTimeAsync(1_000 + IDLE_MS);
      await last;
    }
  });

  it("waits for jobs the local queue returns during the stop until their write lands", async () => {
    vi.useFakeTimers();
    const graphile = stalledRunner();
    run.mockResolvedValueOnce(graphile.runner);
    const { pool } = jobWritePool();
    const host = new GraphileJobWorkerHost(pool, {
      concurrency: 1,
      idleStopTimeoutMs: IDLE_MS,
      drainTimeoutMs: DRAIN_MS,
      localQueueSize: 10,
    });
    await host.start(handlers());
    const on = graphile.runner.events.on as ReturnType<typeof vi.fn>;
    const returning = on.mock.calls.find((call) => call[0] === "localQueue:returnJobs")?.[1] as
      | ((event: { jobs: Array<{ id: string }> }) => void)
      | undefined;
    const stopped = settles(host.stop());
    try {
      // A fetch in flight at the stop returns its jobs to the database unstarted,
      // and they stay locked until that write lands.
      expect(returning).toBeTypeOf("function");
      returning?.({ jobs: [{ id: "job-queued" }] });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stopped.settled).toBe(false);
      await landJobWrite(run.mock.calls[0]![0].pgPool as Pool, "return_job/graphile_worker", [
        "pool-fixture",
        ["job-queued"],
      ]);
      await vi.advanceTimersByTimeAsync(IDLE_MS);
      expect(stopped.settled).toBe(true);
    } finally {
      await vi.advanceTimersByTimeAsync(DRAIN_MS + IDLE_MS);
    }
  });

  it("logs a drain begun by a claim racing the stop as drained", async () => {
    vi.useFakeTimers();
    const writeLanded = deferred();
    run.mockResolvedValueOnce(mockRunner(() => writeLanded.promise.then(() => undefined)).runner);
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: IDLE_MS,
      drainTimeoutMs: DRAIN_MS,
    });
    try {
      await host.start(handlers());
      const stopped = host.stop();
      await run.mock.calls[0]![0].taskList["computer.sleep"](
        { computerId: "late" },
        jobHelpers("job-late"),
      );
      writeLanded.resolve();
      await stopped;
      expect(
        sink.events.map((event) => event.message).filter((message) => message.startsWith("jobs.")),
      ).toEqual(["jobs.draining", "jobs.drained"]);
    } finally {
      writeLanded.resolve();
      await host.stop();
      installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] }));
    }
  });

  it("drains a job claimed by a relaunch that the stop interrupts", async () => {
    vi.useFakeTimers();
    const first = mockRunner();
    const launched = deferred();
    let relaunched!: Runner;
    run.mockResolvedValueOnce(first.runner).mockImplementationOnce(async () => {
      await launched.promise;
      return relaunched;
    });
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: IDLE_MS,
      drainTimeoutMs: DRAIN_MS,
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
      const stopped = settles(host.stop());
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
      await vi.advanceTimersByTimeAsync(1_000);
      // Past the idle bound, but the handler is still running: it must not be failed.
      expect(outcome).toBe("pending");
      expect(stopped.settled).toBe(false);
      release.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped.settled).toBe(true);
      expect(outcome).toBe("resolved");
    } finally {
      release.resolve();
      launched.resolve();
      await host.stop();
    }
  });

  it("drains a running job when Graphile began its own shutdown before the stop", async () => {
    vi.useFakeTimers();
    const graphile = selfStoppingRunner();
    run.mockResolvedValueOnce(graphile.runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: IDLE_MS,
      drainTimeoutMs: DRAIN_MS,
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
      const stopped = settles(host.stop());
      await vi.advanceTimersByTimeAsync(1_000);
      // runner.stop() returned at once, but the handler still runs: leaving now would
      // let the worker close its dependencies under it and leave the job locked.
      expect(outcome).toBe("pending");
      expect(stopped.settled).toBe(false);
      release.resolve();
      await dispatched;
      expect(outcome).toBe("resolved");
      await vi.advanceTimersByTimeAsync(1_000);
      // Graphile's shutdown still flushes the job's completion write.
      expect(stopped.settled).toBe(false);
      graphile.resolveLife();
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped.settled).toBe(true);
    } finally {
      release.resolve();
      graphile.resolveLife();
      await host.stop();
    }
  });

  it("stops an idle host within the idle bound when Graphile's own shutdown stalls", async () => {
    vi.useFakeTimers();
    run.mockResolvedValueOnce(selfStoppingRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, { idleStopTimeoutMs: IDLE_MS });
    await host.start(handlers());
    const stopped = settles(host.stop());
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(stopped.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped.settled).toBe(true);
  });

  it("leaves a restarted host alone when a run abandoned by the previous stop finishes", async () => {
    vi.useFakeTimers();
    run.mockResolvedValueOnce(mockRunner().runner).mockResolvedValueOnce(mockRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: IDLE_MS,
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
      const stopped = host.stop();
      await vi.advanceTimersByTimeAsync(20);
      await stopped;
      await host.start(target);
      // The abandoned run finishes while the restarted host is idle.
      hung.resolve();
      await vi.advanceTimersByTimeAsync(0);
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
      await vi.advanceTimersByTimeAsync(1_000);
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
