import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphileJobPublisher, GraphileJobWorkerHost } from "./wakeup.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

let pool: Pool | undefined;
function testPool(): Pool {
  pool ??= new Pool({ connectionString: databaseUrl, max: 4 });
  return pool;
}
afterEach(async () => {
  await pool?.end();
  pool = undefined;
});

function handlers(overrides: Partial<BackgroundJobHandlers> = {}): BackgroundJobHandlers {
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
    ...overrides,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(assertion: () => void, timeoutMs = 10_000): Promise<void> {
  await vi.waitFor(assertion, { timeout: timeoutMs, interval: 25 });
}

describePostgres("Graphile background jobs (PostgreSQL contract)", () => {
  it("waits for an active handler during graceful shutdown", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    const entered = deferred();
    const release = deferred();
    let completed = false;
    const target = handlers({
      "run.continue": async () => {
        entered.resolve();
        await release.promise;
        completed = true;
      },
    });

    try {
      await host.start(target);
      await publisher.enqueue({ name: "run.continue", payload: { runId: "graceful-stop" } });
      await entered.promise;

      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stopped).toBe(false);

      release.resolve();
      await stopping;
      expect(completed).toBe(true);
    } finally {
      release.resolve();
      await host.stop();
      await publisher.close();
    }
  });

  it("replaces a keyed delayed job without running the old payload or schedule", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    const received: string[] = [];
    const target = handlers({
      "computer.sleep": async ({ computerId }) => {
        received.push(computerId);
      },
    });
    const key = `contract:replacement:${Date.now()}`;

    try {
      await host.start(target);
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { computerId: "old" },
        availableAt: new Date(Date.now() + 300),
        replaceKey: key,
      });
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { computerId: "replacement" },
        availableAt: new Date(Date.now() + 800),
        replaceKey: key,
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(received).toEqual([]);
      await waitFor(() => expect(received).toEqual(["replacement"]));
    } finally {
      await host.stop();
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });

  it("removes a keyed delayed job before a worker can run it", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    const target = handlers();
    const key = `contract:cancellation:${Date.now()}`;

    try {
      await host.start(target);
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { computerId: "cancelled" },
        availableAt: new Date(Date.now() + 300),
        replaceKey: key,
      });
      await publisher.cancel(key);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(target["computer.sleep"]).not.toHaveBeenCalled();
    } finally {
      await host.stop();
      await publisher.close();
    }
  });

  async function keyedRow(key: string): Promise<{
    attempts: number;
    maxAttempts: number;
    runAt: Date;
    payload: string;
  } | null> {
    const result = await testPool().query<{
      attempts: number;
      max_attempts: number;
      run_at: Date;
      payload: unknown;
    }>(
      "select attempts, max_attempts, run_at, payload from graphile_worker._private_jobs where key = $1",
      [key],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      runAt: new Date(row.run_at),
      payload: JSON.stringify(row.payload),
    };
  }

  it("keeps attempts and run_at while a keyed job is still in backoff", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const key = `contract:keep-backoff:${Date.now()}`;
    const runAt = new Date(Date.now() + 60 * 60 * 1000);
    try {
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "backed-off" },
        availableAt: runAt,
        replaceKey: key,
        maxAttempts: 5,
      });
      await testPool().query(
        "update graphile_worker._private_jobs set attempts = 2, run_at = $2 where key = $1",
        [key, runAt],
      );
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "pulled-forward" },
        availableAt: new Date(),
        replaceKey: key,
        keepExisting: true,
      });
      const kept = await keyedRow(key);
      expect(kept?.attempts).toBe(2);
      expect(kept?.maxAttempts).toBe(5);
      expect(kept?.runAt.getTime()).toBe(runAt.getTime());
      expect(kept?.payload).toContain("backed-off");
      expect(kept?.payload).not.toContain("pulled-forward");
    } finally {
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });

  it("re-enqueues an exhausted job with fresh attempts", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const key = `contract:keep-exhausted:${Date.now()}`;
    const revivedAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    try {
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "exhausted" },
        availableAt: new Date(Date.now() + 60 * 60 * 1000),
        replaceKey: key,
        maxAttempts: 3,
      });
      await testPool().query(
        "update graphile_worker._private_jobs set attempts = max_attempts where key = $1",
        [key],
      );
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "revived" },
        availableAt: revivedAt,
        replaceKey: key,
        keepExisting: true,
      });
      const revived = await keyedRow(key);
      expect(revived?.attempts).toBe(0);
      expect(revived?.runAt.getTime()).toBe(revivedAt.getTime());
      expect(revived?.payload).toContain("revived");
    } finally {
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });

  it("enqueues a keepExisting job when the key is missing", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const key = `contract:keep-missing:${Date.now()}`;
    const runAt = new Date(Date.now() + 3 * 60 * 60 * 1000);
    try {
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "fresh" },
        availableAt: runAt,
        replaceKey: key,
        keepExisting: true,
      });
      const inserted = await keyedRow(key);
      expect(inserted?.attempts).toBe(0);
      expect(inserted?.runAt.getTime()).toBe(runAt.getTime());
      expect(inserted?.payload).toContain("fresh");
    } finally {
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });

  it("persists a handler failure and retries the job successfully", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    let attempts = 0;
    const target = handlers({
      "run.continue": async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("intentional contract-test failure");
      },
    });
    const key = `contract:retry:${Date.now()}`;

    try {
      await host.start(target);
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "retry" },
        replaceKey: key,
      });
      await waitFor(() => expect(attempts).toBe(2), 15_000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(attempts).toBe(2);
    } finally {
      await host.stop();
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });
});
