import type { BackgroundJob, BackgroundJobHandlers } from "@rakazo/adapter-kit";
import { messagingDeliverJob, routineWakeupJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { createPool, currentDbContext, runAsTenant } from "@rakazo/db";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDeadJobPruner,
  createReservedGraphileJobWorkerHost,
  GraphileJobPublisher,
  GraphileJobWorkerHost,
} from "./wakeup.js";

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
    "routine.retry": vi.fn(async () => undefined),
    "computer.update": vi.fn(async () => undefined),
    "computer.sleep": vi.fn(async () => undefined),
    "computer.control-expire": vi.fn(async () => undefined),
    "skill.teaching-expire": vi.fn(async () => undefined),
    "call.expire": vi.fn(async () => undefined),
    "history.compact": vi.fn(async () => undefined),
    "messaging.deliver": vi.fn(async () => undefined),
    "messaging.credential-cleanup": vi.fn(async () => undefined),
    "cloud_agent.poll": vi.fn(async () => undefined),
    "purchase.poll": vi.fn(async () => undefined),
    "push.receipt": vi.fn(async () => undefined),
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
  it("starts a fifth agent while four agents wait on model work", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 4, pollInterval: 25 });
    const release = deferred();
    const entered: string[] = [];
    const target = handlers({
      "run.continue": async ({ runId }, execution) => {
        entered.push(runId);
        execution!.onRunStarted();
        await release.promise;
      },
    });
    try {
      await host.start(target);
      for (let i = 0; i < 4; i++)
        await publisher.enqueue({ name: "run.continue", payload: { runId: `waiting-agent-${i}` } });
      await waitFor(() => expect(entered).toHaveLength(4));
      await publisher.enqueue({ name: "run.continue", payload: { runId: "fifth-agent" } });
      await waitFor(() => expect(entered).toContain("fifth-agent"));
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
      await publisher.close();
    }
  });

  it("starts chat while routine and maintenance capacity are occupied", async () => {
    const prisma = {
      run: {
        findUnique: async ({ where }: { where: { id: string } }) => ({
          trigger: where.id.startsWith("routine-") ? "routine" : "user",
        }),
      },
    } as unknown as Pick<PrismaClient, "run">;
    const publisher = new GraphileJobPublisher(testPool(), prisma);
    const legacy = new GraphileJobPublisher(testPool());
    const host = createReservedGraphileJobWorkerHost(testPool(), {
      concurrency: 1,
      pollInterval: 25,
    });
    const routineEntered = deferred();
    const maintenanceEntered = deferred();
    const release = deferred();
    const received: string[] = [];
    const target = handlers({
      "run.continue": async ({ runId }) => {
        received.push(runId);
        if (runId.startsWith("routine-")) {
          routineEntered.resolve();
          await release.promise;
        }
      },
      "computer.sleep": async () => {
        maintenanceEntered.resolve();
        await release.promise;
      },
    });
    try {
      await publisher.enqueue({ name: "run.continue", payload: { runId: "routine-first" } });
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { computerId: "fixture-computer" },
      });
      await host.start(target);
      await Promise.all([routineEntered.promise, maintenanceEntered.promise]);
      await publisher.enqueue({ name: "run.continue", payload: { runId: "routine-pending" } });
      await publisher.enqueue({ name: "run.continue", payload: { runId: "chat-new" } });
      // A pre-release queue entry must move even while the legacy runner is busy.
      const key = "contract:reserved:legacy";
      await legacy.enqueue({
        name: "run.continue",
        payload: { runId: "chat-legacy" },
        replaceKey: key,
      });
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "chat-legacy" },
        replaceKey: key,
        keepExisting: true,
      });
      await waitFor(() => expect(received).toEqual(["routine-first", "chat-new", "chat-legacy"]));
      release.resolve();
      await waitFor(() => expect(received).toContain("routine-pending"));
    } finally {
      release.resolve();
      await host.stop();
      await publisher.close();
      await legacy.close();
    }
  });

  it("starts due maintenance jobs while others are still running", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = createReservedGraphileJobWorkerHost(testPool(), { pollInterval: 25 });
    const release = deferred();
    const sleeping: string[] = [];
    const woken: string[] = [];
    try {
      await host.start(
        handlers({
          "computer.sleep": async ({ computerId }) => {
            sleeping.push(computerId);
            await release.promise;
          },
          "routine.wakeup": async ({ routineId }) => {
            woken.push(routineId);
          },
        }),
      );
      for (const computerId of ["computer-a", "computer-b", "computer-c"]) {
        await publisher.enqueue({ name: "computer.sleep", payload: { computerId } });
      }
      await waitFor(() => expect(sleeping).toHaveLength(3));
      await publisher.enqueue(routineWakeupJob("routine-due", new Date()));
      await waitFor(() => expect(woken).toEqual(["routine-due"]));
    } finally {
      release.resolve();
      await host.stop();
      await publisher.close();
    }
  });

  it("runs outgoing message drains in parallel", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = createReservedGraphileJobWorkerHost(testPool(), { pollInterval: 25 });
    const release = deferred();
    const draining: string[] = [];
    try {
      await host.start(
        handlers({
          "messaging.deliver": async ({ runId }) => {
            draining.push(runId ?? "drain");
            await release.promise;
          },
        }),
      );
      await publisher.enqueue(messagingDeliverJob("run-first"));
      await waitFor(() => expect(draining).toEqual(["run-first"]));
      // The second drain starts while the first is still sending: one slow
      // conversation must not hold back the rest of the outbox. Order inside a
      // conversation is kept by the drain's claim, not by a shared queue.
      await publisher.enqueue(messagingDeliverJob("run-second"));
      await waitFor(() => expect(draining).toEqual(["run-first", "run-second"]));
      release.resolve();
    } finally {
      release.resolve();
      await host.stop();
      await publisher.close();
    }
  });

  it.each([false, true])(
    "preserves legacy retry state while routing chat (locked=%s)",
    async (locked) => {
      const prisma = { run: { findUnique: async () => ({ trigger: "user" }) } } as unknown as Pick<
        PrismaClient,
        "run"
      >;
      const publisher = new GraphileJobPublisher(testPool(), prisma);
      const legacy = new GraphileJobPublisher(testPool());
      const key = `contract:reserved:backoff:${locked}`;
      const runAt = new Date(Date.now() + 60_000);
      try {
        await legacy.enqueue({
          name: "run.continue",
          payload: { runId: "chat-backoff" },
          replaceKey: key,
          availableAt: runAt,
          maxAttempts: 5,
        });
        await testPool().query(
          "update graphile_worker._private_jobs set attempts = 2, locked_at = $2, locked_by = $3 where key = $1",
          [key, locked ? new Date() : null, locked ? "fixture-worker" : null],
        );
        const before = await keyedRow(key);
        await publisher.enqueue({
          name: "run.continue",
          payload: { runId: "chat-backoff" },
          replaceKey: key,
          keepExisting: true,
        });
        expect(await keyedRow(key)).toEqual(before);
        const { rows } = await testPool().query<{ task_identifier: string }>(
          "select task_identifier from graphile_worker.jobs where key = $1",
          [key],
        );
        expect(rows[0]?.task_identifier).toBe(locked ? "run.continue" : "run.interactive");
      } finally {
        await testPool().query(
          "update graphile_worker._private_jobs set locked_at = null, locked_by = null where key = $1",
          [key],
        );
        await publisher.cancel(key);
        await publisher.close();
        await legacy.close();
      }
    },
  );

  it("keeps a failed legacy chat delivery keyed when reconciliation promotes it", async () => {
    const prisma = {
      run: { findUnique: async () => ({ trigger: "user" }) },
    } as unknown as Pick<PrismaClient, "run">;
    const legacy = new GraphileJobPublisher(testPool());
    const publisher = new GraphileJobPublisher(testPool(), prisma);
    const host = createReservedGraphileJobWorkerHost(testPool(), {
      concurrency: 1,
      pollInterval: 25,
    });
    const key = "contract:reserved:failed-legacy";
    const runId = "failed-legacy-chat";
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("fixture failure before the run lease"))
      .mockResolvedValue(undefined);
    try {
      await legacy.enqueue({
        name: "run.continue",
        payload: { runId },
        replaceKey: key,
        maxAttempts: 3,
      });
      await host.start(handlers({ "run.continue": execute }));
      await waitFor(async () => {
        const { rows } = await testPool().query(
          "select attempts, locked_at, last_error from graphile_worker._private_jobs where key = $1",
          [key],
        );
        expect(rows[0]).toMatchObject({
          attempts: 1,
          locked_at: null,
          last_error: expect.any(String),
        });
      });
      await testPool().query(
        "update graphile_worker._private_jobs set run_at = now() + interval '1 hour' where key = $1",
        [key],
      );
      const before = await keyedRow(key);
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId },
        replaceKey: key,
        keepExisting: true,
      });
      expect(await keyedRow(key)).toEqual(before);
      const { rows } = await testPool().query(
        "select key, task_identifier from graphile_worker.jobs where key = $1",
        [key],
      );
      expect(rows).toEqual([{ key, task_identifier: "run.interactive" }]);
      expect(execute).toHaveBeenCalledTimes(1);
      await testPool().query(
        "update graphile_worker._private_jobs set run_at = now() where key = $1",
        [key],
      );
      await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
      await waitFor(async () => expect(await keyedRow(key)).toBeNull());
    } finally {
      await host.stop();
      await publisher.cancel(key);
      await publisher.close();
      await legacy.close();
    }
  });

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

  it("replaces a job still locked by a worker that died mid-job", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const key = `contract:keep-locked:${Date.now()}`;
    const deadWorker = `contract-dead-worker-${Date.now()}`;
    const lockedAt = new Date("2025-01-01T00:00:00.000Z");
    try {
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "abandoned" },
        replaceKey: key,
      });
      await testPool().query(
        `update graphile_worker._private_jobs
         set attempts = 1, locked_at = $3, locked_by = $2 where key = $1`,
        [key, deadWorker, lockedAt],
      );
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "reclaimed" },
        replaceKey: key,
        keepExisting: true,
        replaceLockedBefore: new Date(lockedAt.getTime() + 1),
      });
      const reclaimed = await keyedRow(key);
      expect(reclaimed?.attempts).toBe(0);
      expect(reclaimed?.payload).toContain("reclaimed");
      const detached = await testPool().query<{ key: string | null }>(
        "select key from graphile_worker._private_jobs where locked_by = $1",
        [deadWorker],
      );
      expect(detached.rows).toEqual([{ key: null }]);
    } finally {
      await testPool()
        .query("delete from graphile_worker._private_jobs where locked_by = $1", [deadWorker])
        .catch(() => undefined);
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });

  it("keeps a job locked after replaceLockedBefore", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const key = `contract:keep-live-lock:${Date.now()}`;
    const liveWorker = `contract-live-worker-${Date.now()}`;
    try {
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "finishing" },
        replaceKey: key,
      });
      await testPool().query(
        `update graphile_worker._private_jobs
         set attempts = 1, locked_at = now(), locked_by = $2 where key = $1`,
        [key, liveWorker],
      );
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "too-early" },
        replaceKey: key,
        keepExisting: true,
        replaceLockedBefore: new Date(Date.now() - 5 * 60_000),
      });
      const kept = await keyedRow(key);
      expect(kept?.attempts).toBe(1);
      expect(kept?.payload).toContain("finishing");
    } finally {
      await testPool()
        .query("delete from graphile_worker._private_jobs where locked_by = $1", [liveWorker])
        .catch(() => undefined);
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

  // `pnpm test:integration` connects as the runtime login. graphile-worker turns on
  // row-level security for its own tables, so without the queue policy that
  // `pnpm db:migrate` installs, the runtime login can neither add nor take a job.
  it("enqueues from a request and runs the job as the restricted runtime login", async () => {
    const appPool = createPool(databaseUrl!);
    const workerPool = createPool(databaseUrl!);
    const { rows } = await appPool.query<{ restricted: boolean }>(
      `select not (r.rolsuper or r.rolbypassrls
          or pg_has_role(current_user, c.relowner, 'USAGE')) as restricted
         from pg_roles r, pg_class c
        where r.rolname = current_user and c.oid = 'graphile_worker._private_jobs'::regclass`,
    );
    expect(rows[0]?.restricted).toBe(true);
    const publisher = new GraphileJobPublisher(appPool);
    const host = new GraphileJobWorkerHost(workerPool, { concurrency: 1, pollInterval: 25 });
    const contexts: unknown[] = [];
    const key = `contract:restricted:${Date.now()}`;
    try {
      await host.start(
        handlers({
          "run.continue": async () => {
            contexts.push(currentDbContext());
          },
        }),
      );
      // The API enqueues inside the signed-in Space's context, keepExisting
      // included, which reads the queue table before adding the job.
      await runAsTenant({ spaceId: "space-restricted", userId: "user-restricted" }, () =>
        publisher.enqueue({
          name: "run.continue",
          payload: { runId: "restricted" },
          replaceKey: key,
          keepExisting: true,
        }),
      );
      await waitFor(() => expect(contexts).toHaveLength(1));
      expect(contexts[0]).toEqual({ kind: "system", reason: "background job run.continue" });
    } finally {
      await host.stop();
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
      await appPool.end();
      await workerPool.end();
    }
  });

  it("prunes only exhausted jobs past retention, keeping retry notices and live jobs", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const prefix = `contract:prune:${Date.now()}`;
    const jobs = {
      oldDead: { name: "computer.sleep", payload: { computerId: "old-dead" } },
      recentDead: { name: "computer.sleep", payload: { computerId: "recent-dead" } },
      lockedDead: { name: "computer.sleep", payload: { computerId: "locked-dead" } },
      oldLive: { name: "computer.sleep", payload: { computerId: "old-live" } },
      notice: { name: "routine.retry", payload: { runId: "notice" } },
    } as const;
    const keys = Object.keys(jobs).map((name) => `${prefix}:${name}`);
    try {
      for (const [name, job] of Object.entries(jobs)) {
        await publisher.enqueue({ ...job, replaceKey: `${prefix}:${name}` } as BackgroundJob);
      }
      await testPool().query(
        `update graphile_worker._private_jobs
         set attempts = case when key = $2 then 1 else max_attempts end,
             locked_at = case when key = $3 then now() else null end,
             locked_by = case when key = $3 then 'contract-worker' else null end,
             updated_at = case when key = $4 then now() else now() - interval '8 days' end
         where key = any($1::text[])`,
        [keys, `${prefix}:oldLive`, `${prefix}:lockedDead`, `${prefix}:recentDead`],
      );

      await createDeadJobPruner(testPool())();

      const remaining = await testPool().query<{ key: string }>(
        "select key from graphile_worker._private_jobs where key = any($1::text[]) order by key",
        [keys],
      );
      expect(remaining.rows.map((row) => row.key.slice(prefix.length + 1)).sort()).toEqual([
        "lockedDead",
        "notice",
        "oldLive",
        "recentDead",
      ]);
    } finally {
      await testPool().query("delete from graphile_worker._private_jobs where key = any($1)", [
        keys,
      ]);
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
