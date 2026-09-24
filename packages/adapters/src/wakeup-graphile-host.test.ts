import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import {
  HISTORY_COMPACT_MAX_ATTEMPTS,
  historyCompactJob,
  messagingDeliverJob,
} from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger, wrapJobPayload } from "@rakazo/logging";
import type { Runner } from "graphile-worker";
import { makeWorkerUtils } from "graphile-worker";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

const run = vi.hoisted(() => vi.fn());

vi.mock("graphile-worker", () => ({
  run: (...args: unknown[]) => run(...args),
  makeWorkerUtils: vi.fn(),
}));

import {
  databaseCapacityBackoffMs,
  GraphileJobPublisher,
  GraphileJobWorkerHost,
} from "./wakeup.js";

function handlers(): BackgroundJobHandlers {
  return {
    "run.continue": vi.fn(async () => undefined),
    "routine.wakeup": vi.fn(async () => undefined),
    "computer.update": vi.fn(async () => undefined),
    "computer.sleep": vi.fn(async () => undefined),
    "computer.control-expire": vi.fn(async () => undefined),
    "skill.teaching-expire": vi.fn(async () => undefined),
    "history.compact": vi.fn(async () => undefined),
    "messaging.deliver": vi.fn(async () => undefined),
    "cloud_agent.poll": vi.fn(async () => undefined),
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

function mockRunner() {
  const life = deferred();
  // Keep a rejection handler so Node does not treat the mock lifecycle as an
  // unexpected unhandledRejection before the host attaches supervise().
  life.promise.catch(() => undefined);
  const runner = {
    promise: life.promise,
    stop: vi.fn(async () => {
      life.resolve();
    }),
    kill: vi.fn(async () => undefined),
    addJob: vi.fn(),
    events: { on: vi.fn(), off: vi.fn(), once: vi.fn(), emit: vi.fn() },
  } as unknown as Runner;
  return {
    runner,
    rejectLife: (error: unknown) => life.reject(error),
  };
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
    await publisher.enqueue(messagingDeliverJob("run-1"));
    const options = addJob.mock.calls[0]?.[2] as { maxAttempts?: number } | undefined;
    expect(options?.maxAttempts).toBeUndefined();
    await publisher.close();
  });
});

describe("GraphileJobWorkerHost runner lifecycle", () => {
  afterEach(() => {
    run.mockReset();
  });

  it("backs off then restarts when runner.promise rejects with 53300", async () => {
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
    expect(run).toHaveBeenCalledTimes(1);

    first.rejectLife(tooMany);
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

  it("does not restart when runner.promise rejects for a non-53300 error", async () => {
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
