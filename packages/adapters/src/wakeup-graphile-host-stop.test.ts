import { getHeapStatistics } from "node:v8";
import { deferred } from "@rakazo/core/test-async";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import type * as GraphileWorker from "graphile-worker";
import type { Runner } from "graphile-worker";
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
}));

import { GraphileJobWorkerHost } from "./wakeup.js";
import {
  DRAIN_MS,
  handlers,
  helpers,
  IDLE_MS,
  mockRunner,
  selfStoppingRunner,
  settles,
  stalledRunner,
  tooMany,
} from "./wakeup-graphile-host.test-support.js";

describe("GraphileJobWorkerHost stop", () => {
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

  it("keeps draining a running job, then bounds the rest of a stalled shutdown", async () => {
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
        helpers,
      ).catch(() => undefined);
      const stopped = settles(host.stop());
      await vi.advanceTimersByTimeAsync(1_000);
      // A job is running, so the idle bound must not cut the drain short.
      expect(stopped.settled).toBe(false);
      release.resolve();
      await dispatched;
      // Only the completion write and housekeeping remain: the idle bound applies.
      await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
      expect(stopped.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(stopped.settled).toBe(true);
    } finally {
      release.resolve();
      await host.stop();
    }
  });

  it("gives the failure writes of jobs the drain deadline failed the idle bound", async () => {
    vi.useFakeTimers();
    run.mockResolvedValueOnce(stalledRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 1,
      idleStopTimeoutMs: IDLE_MS,
      drainTimeoutMs: DRAIN_MS,
    });
    const target = handlers();
    target["computer.sleep"] = async () => new Promise<void>(() => undefined);
    await host.start(target);
    const failed = run.mock.calls[0]![0].taskList["computer.sleep"](
      { computerId: "hung" },
      helpers,
    ).then(
      () => undefined,
      (error: Error) => error.message,
    );
    const stopped = settles(host.stop());
    await vi.advanceTimersByTimeAsync(DRAIN_MS);
    expect(await failed).toBe("The worker stopped before this job finished");
    expect(stopped.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(stopped.settled).toBe(true);
  });

  it("bounds remaining housekeeping once a handed-off run finishes", async () => {
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
      // The wrapper settles at durable handoff; the run keeps executing.
      await run.mock.calls[0]![0].taskList["run.continue"]({ runId: "handed-off" }, helpers).catch(
        () => undefined,
      );
      const stopped = settles(host.stop());
      await vi.advanceTimersByTimeAsync(1_000);
      // The handed-off run still owns its lease, so the drain bound applies.
      expect(stopped.settled).toBe(false);
      release.resolve();
      await vi.advanceTimersByTimeAsync(IDLE_MS);
      expect(stopped.settled).toBe(true);
    } finally {
      release.resolve();
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
        helpers,
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
    const host = new GraphileJobWorkerHost({} as Pool, {
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
      const stopped = settles(host.stop());
      // The first late claim settles, so the deadline is back at the idle bound.
      await taskList["computer.sleep"]({ computerId: "first" }, helpers);
      // A second claim from another in-flight poll arrives afterwards.
      const second = taskList["computer.sleep"]({ computerId: "second" }, helpers).catch(
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stopped.settled).toBe(false);
      release.resolve();
      await second;
      await vi.advanceTimersByTimeAsync(IDLE_MS);
      expect(stopped.settled).toBe(true);
    } finally {
      release.resolve();
      await host.stop();
    }
  });

  it("keeps one drain budget when a claim arrives after the running job finished", async () => {
    vi.useFakeTimers();
    run.mockResolvedValueOnce(stalledRunner().runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      concurrency: 2,
      idleStopTimeoutMs: IDLE_MS,
      drainTimeoutMs: DRAIN_MS,
    });
    const release = deferred();
    const target = handlers();
    target["computer.sleep"] = async (payload) => {
      if ((payload as { computerId: string }).computerId === "first") await release.promise;
      else await new Promise<void>(() => undefined);
    };
    await host.start(target);
    const taskList = run.mock.calls[0]![0].taskList;
    const first = taskList["computer.sleep"]({ computerId: "first" }, helpers);
    const stopped = settles(host.stop());
    await vi.advanceTimersByTimeAsync(DRAIN_MS - 1_000);
    release.resolve();
    await first;
    // A late claim lands in the idle window and never finishes.
    const late = taskList["computer.sleep"]({ computerId: "late" }, helpers).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1_000 + IDLE_MS);
    expect(stopped.settled).toBe(true);
    await late;
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
        helpers,
      );
      await expect(late).rejects.toThrow();
      // Graphile fails the job at once, so its handler must not be running here.
      expect(target["computer.sleep"]).not.toHaveBeenCalled();
    } finally {
      await host.stop();
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
      await run.mock.calls[0]![0].taskList["computer.sleep"]({ computerId: "late" }, helpers);
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
        helpers,
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
        helpers,
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
      graphile.resolveLife();
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped.settled).toBe(true);
    } finally {
      release.resolve();
      graphile.resolveLife();
      await host.stop();
    }
  });

  it("waits for a running job before surfacing a failed runner stop", async () => {
    vi.useFakeTimers();
    const failure = new Error("fixture stop failure");
    const graphile = mockRunner(async () => {
      throw failure;
    });
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
      const dispatched = run.mock.calls[0]![0].taskList["computer.sleep"](
        { computerId: "saving" },
        helpers,
      );
      const stopping = host.stop();
      const stopped = settles(stopping);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stopped.settled).toBe(false);
      release.resolve();
      await dispatched;
      graphile.resolveLife();
      await expect(stopping).rejects.toBe(failure);
    } finally {
      release.resolve();
      graphile.resolveLife();
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
      await run.mock.calls[0]![0].taskList["run.continue"]({ runId: "abandoned-run" }, helpers);
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
        helpers,
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
});
